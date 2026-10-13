"""Git-backed agent configuration. Standard library only; no bundled user content."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import plistlib
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

VERSION = '0.1.0'
SKILL_ROOTS = {'claude': '.claude/skills', 'codex': '.agents/skills', 'cursor': '.cursor/skills', 'gemini': '.gemini/skills', 'opencode': '.config/opencode/skills'}
INSTRUCTION_FILES = {'claude': '.claude/CLAUDE.md', 'codex': '.codex/AGENTS.md'}
START = '<!-- agent-backbone:begin -->'
END = '<!-- agent-backbone:end -->'

def paths():
    home = Path.home()
    config = home/'.config/agent-backbone'
    state = home/'.local/state/agent-backbone'
    return home, config, state

def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except FileNotFoundError:
        return {} if default is None else default

def atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name+'.tmp')
    pending.write_text(text)
    pending.replace(path)

def save_json(path, data):
    atomic_write(path, json.dumps(data, indent=2)+'\n')

def run(argv, cwd=None, timeout=25):
    env = os.environ.copy()
    env.update(GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='never')
    process = subprocess.Popen([str(a) for a in argv], cwd=cwd, env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise RuntimeError('Command timed out; local content retained.')
    if process.returncode:
        raise RuntimeError((stderr or stdout).strip()[-1200:])
    return stdout.strip()

def command_path():
    return Path(os.environ.get('AGENT_BACKBONE_COMMAND', sys.argv[0])).absolute()

def engine_path():
    candidate = os.environ.get('AGENT_BACKBONE_SKILLSHARE')
    if candidate:
        return str(Path(candidate).absolute())
    bundled = Path(__file__).resolve().parents[1]/'vendor/skillshare'
    if bundled.exists():
        return str(bundled)
    found = shutil.which('skillshare')
    if not found:
        raise RuntimeError('Skillshare engine unavailable. Install Agent Backbone with Homebrew.')
    return found

def repository_url(value):
    if re.fullmatch(r'[\w.-]+/[\w.-]+', value):
        return 'https://github.com/'+value.removesuffix('.git')+'.git'
    if value.startswith(('https://', 'ssh://', 'git@')):
        if value.startswith('https://') and '@' in value.split('://', 1)[1].split('/', 1)[0]:
            raise RuntimeError('Use a credential helper, not credentials embedded in the repository URL.')
        return value
    raise RuntimeError('Use an existing local directory, owner/repo, or a Git URL.')

def contained(repo, relative, must_exist=True):
    value = Path(relative)
    if value.is_absolute() or '..' in value.parts:
        raise RuntimeError('Manifest paths must stay within the source repository.')
    result = repo/value
    if not result.resolve().is_relative_to(repo.resolve()):
        raise RuntimeError('Manifest path escapes the repository: '+relative)
    if must_exist and not result.exists():
        raise RuntimeError('Manifest path missing: '+relative)
    return result

def manifest(repo):
    data = read_json(repo/'backbone.json', {'schema_version': 1, 'skills_dir': 'skills'})
    if data.get('schema_version') != 1:
        raise RuntimeError('Unsupported backbone.json schema version.')
    source = contained(repo, data.get('skills_dir', 'skills'))
    seen = set()
    for package in data.get('packages', []):
        name = package['name']
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name) or name in seen:
            raise RuntimeError('Package names must be unique lowercase slugs.')
        seen.add(name)
        contained(repo, package['path'])
        for local in package.get('local_files', []):
            contained(repo, str(Path(package['path'])/local), must_exist=False)
        if package.get('host_notes'):
            contained(repo, str(Path(package['path'])/package['host_notes']))
        if package.get('provenance_file'):
            contained(repo, str(Path(package['path'])/package['provenance_file']), must_exist=False)
    for instruction in data.get('instructions', []):
        contained(repo, instruction['path'])
    for entry in source.iterdir():
        if entry.is_dir() and (entry/'SKILL.md').exists():
            if not entry.resolve().is_relative_to(repo.resolve()):
                raise RuntimeError('Skill link escapes the repository: '+entry.name)
    return data

def source_skills(repo, data):
    source = contained(repo, data.get('skills_dir', 'skills'))
    return {p.name: p for p in source.iterdir() if p.is_dir() and (p/'SKILL.md').exists()}

def previous_config():
    home, directory, _ = paths()
    current = read_json(directory/'config.json')
    return current or read_json(home/'.config/skill-backbone/host.json')

def is_owned(path, previous):
    if not path.is_symlink():
        return False
    if str(path) in previous.get('managed_links', {}):
        return str(path.resolve()) == previous['managed_links'][str(path)]
    old = previous.get('repo')
    return bool(old and path.resolve().is_relative_to(Path(old).resolve()))

def apply(repo, data, agents, previous, backup, engine):
    home, directory, _ = paths()
    skills = source_skills(repo, data)
    plugin_skills = set()
    for package in data.get('packages', []):
        if package.get('claude_plugin'):
            package_root = contained(repo, package['path']).resolve()
            plugin_skills.update(name for name, skill in skills.items() if skill.resolve().is_relative_to(package_root))
    if plugin_skills and 'claude' in agents:
        claude_root = (home/SKILL_ROOTS['claude']).resolve()
        if any(agent != 'claude' and (home/SKILL_ROOTS[agent]).resolve() == claude_root for agent in agents):
            raise RuntimeError('Claude shares its skill root with another agent. Full-plugin delivery needs separate roots to avoid duplicate registration; existing dotfiles are untouched.')
    desired = {}
    for agent in agents:
        for name, source in skills.items():
            if agent == 'claude' and name in plugin_skills:
                continue
            desired[home/SKILL_ROOTS[agent]/name] = source.resolve()
    for package in data.get('packages', []):
        source = contained(repo, package['path']).resolve()
        desired[home/'.agents/packages'/package['name']] = source
        if package.get('claude_plugin') and 'claude' in agents:
            desired[home/'.claude/skills'/package['name']] = source
    # Resolve every conflict before changing any destination.
    for target, source in desired.items():
        if target.exists() or target.is_symlink():
            if target.is_symlink() and target.resolve() == source:
                continue
            if not is_owned(target, previous):
                raise RuntimeError('Unmanaged destination conflicts with shared content: '+str(target))
    for agent in agents:
        if agent in INSTRUCTION_FILES:
            note = home/INSTRUCTION_FILES[agent]
            text = note.read_text() if note.exists() else ''
            if text.count(START) != text.count(END) or text.count(START) > 1:
                raise RuntimeError('Malformed managed instruction block: '+str(note))
    backup.mkdir(parents=True, exist_ok=True)
    for old_path, old_source in previous.get('managed_links', {}).items():
        target = Path(old_path)
        if target not in desired and target.is_symlink() and str(target.resolve()) == old_source:
            target.rename(backup/(str(target.relative_to(home)).replace('/', '__')))
    for target, source in desired.items():
        if target.is_symlink() and target.resolve() == source:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            target.rename(backup/(str(target.relative_to(home)).replace('/', '__')))
        target.symlink_to(source, target_is_directory=True)
    # Write Skillshare configuration for native skills, excluding full Claude plugins.
    targets = {}
    for agent in agents:
        targets[agent] = {'path': str(home/SKILL_ROOTS[agent])}
        if agent == 'claude' and plugin_skills:
            targets[agent]['exclude'] = sorted(plugin_skills)
    skill_config = directory/'skillshare.yaml'
    save_json(skill_config, {'source': str(contained(repo, data.get('skills_dir', 'skills'))),
                            'follow_source_links': True, 'mode': 'merge', 'targets': targets,
                            'ignore': ['.git/', '.DS_Store', '__pycache__/']})
    old_environment = os.environ.get('SKILLSHARE_CONFIG')
    os.environ['SKILLSHARE_CONFIG'] = str(skill_config)
    try:
        run([engine, 'sync', '--global'])
    finally:
        if old_environment is None:
            os.environ.pop('SKILLSHARE_CONFIG', None)
        else:
            os.environ['SKILLSHARE_CONFIG'] = old_environment
    for agent in agents:
        if agent not in INSTRUCTION_FILES:
            continue
        chunks = []
        for entry in data.get('instructions', []):
            if agent in entry.get('agents', ['claude', 'codex']):
                chunks.append(contained(repo, entry['path']).read_text().strip())
        for package in data.get('packages', []):
            if package.get('host_notes'):
                note = home/'.agents/packages'/package['name']/package['host_notes']
                chunks.append('When using '+package['name']+', first read '+str(note)+' for host compatibility. Preserve current user instructions.')
        path = home/INSTRUCTION_FILES[agent]
        # Keep dotfiles symlinks intact and preserve the content outside our block.
        actual = path.resolve() if path.is_symlink() else path
        text = actual.read_text() if actual.exists() else ''
        if text.count(START) != text.count(END) or text.count(START) > 1:
            raise RuntimeError('Malformed managed instruction block: '+str(path))
        cleaned = re.sub(re.escape(START)+r'.*?'+re.escape(END)+'\n?', '', text, flags=re.S).rstrip()
        block = START+'\n\n'+'\n\n'.join(chunks)+'\n\n'+END
        updated = (cleaned+'\n\n' if cleaned else '')+block+'\n'
        if updated != text:
            if actual.exists():
                shutil.copy2(actual, backup/(agent+'-instructions.md'))
            atomic_write(actual, updated)
    return {str(target): str(source) for target, source in desired.items()}

def configure(args):
    home, directory, state = paths()
    previous = previous_config()
    local = Path(args.repository).expanduser()
    if local.is_dir():
        repo = local.resolve()
        run(['git', 'rev-parse', '--show-toplevel'], cwd=repo)
    else:
        repo = Path(args.destination).expanduser().absolute() if args.destination else home/'.local/share/agent-backbone/library'
        url = repository_url(args.repository)
        if repo.exists():
            if run(['git', 'remote', 'get-url', 'origin'], cwd=repo) != url:
                raise RuntimeError('Destination already contains another source. Choose --destination.')
        else:
            repo.parent.mkdir(parents=True, exist_ok=True)
            run(['git', 'clone', url, str(repo)], timeout=60)
    data = manifest(repo)
    agents = args.agents.split(',')
    if not agents or any(agent not in SKILL_ROOTS for agent in agents):
        raise RuntimeError('Supported agent targets: '+', '.join(SKILL_ROOTS))
    run(['git', 'config', 'pull.ff', 'only'], cwd=repo)
    backup = state/('backup-'+str(time.time_ns()))
    engine = engine_path()
    managed = apply(repo, data, agents, previous, backup, engine)
    originals = dict(previous.get('agents', {}))
    bin_dir = home/'.local/bin'
    bin_dir.mkdir(parents=True, exist_ok=True)
    for agent in agents:
        if agent in originals:
            continue
        found = shutil.which(agent)
        current = bin_dir/agent
        if current.exists() or current.is_symlink():
            destination = backup/('original-'+agent)
            current.rename(destination)
            originals[agent] = str(destination)
        elif found:
            originals[agent] = found
    command = str(command_path())
    config = {'repo': str(repo), 'agents': originals, 'targets': agents,
              'engine': engine, 'command': command, 'managed_links': managed,
              'interval': args.interval, 'backup': str(backup)}
    save_json(directory/'config.json', config)
    for agent in agents:
        if agent not in originals:
            continue
        wrapper = bin_dir/agent
        atomic_write(wrapper, '#!/bin/sh\nexec '+shlex.join([command, 'launch', agent, '--'])+' "$@"\n')
        wrapper.chmod(0o755)
    helper = bin_dir/'agent-backbone-refresh'
    atomic_write(helper, '#!/bin/sh\nexec '+shlex.join([command, 'sync', '--startup'])+'\n')
    helper.chmod(0o755)
    if 'claude' in agents:
        settings = home/'.claude/settings.json'
        settings_target = settings.resolve() if settings.is_symlink() else settings
        document = read_json(settings_target)
        hooks = document.setdefault('hooks', {}).setdefault('SessionStart', [])
        old_helper = str(home/'.local/bin/skill-backbone-refresh')
        hooks[:] = [entry for entry in hooks if not (len(entry.get('hooks', [])) == 1 and entry['hooks'][0].get('command') in [str(helper), old_helper])]
        hooks.append({'matcher': 'startup|resume', 'hooks': [{'type': 'command', 'command': str(helper), 'timeout': 30}]})
        if settings_target.exists():
            shutil.copy2(settings_target, backup/'claude-settings.json')
        save_json(settings_target, document)
    if not args.no_background and sys.platform == 'darwin':
        domain = 'gui/'+str(os.getuid())
        # Stop only the previous backbone timer during migration.
        run_command = ['launchctl', 'bootout', domain+'/ai.skill-backbone.refresh']
        subprocess.run(run_command, capture_output=True)
        label = 'ai.agent-backbone.refresh'
        plist = home/'Library/LaunchAgents'/(label+'.plist')
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': [command, 'sync', '--startup'],
                                         'StartInterval': args.interval, 'RunAtLoad': True,
                                         'StandardOutPath': str(state/'background.log'),
                                         'StandardErrorPath': str(state/'background-error.log')}))
        subprocess.run(['launchctl', 'bootout', domain+'/'+label], capture_output=True)
        result = subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], capture_output=True)
        if result.returncode:
            print('Background timer unavailable in this GUI session; launch refresh remains enabled.', file=sys.stderr)
    sync(startup=True)
    print('Configured '+str(repo)+' for '+', '.join(agents)+'. Backups: '+str(backup))

def config():
    _, directory, _ = paths()
    result = read_json(directory/'config.json')
    if not result:
        raise RuntimeError('Run agent-backbone configure <repository> first.')
    return result

def sync(startup=False):
    _, directory, state = paths()
    current = config()
    repo = Path(current['repo'])
    state.mkdir(parents=True, exist_ok=True)
    with (state/'sync.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print('Refresh already running; current local setup retained.', file=sys.stderr)
            return
        health = read_json(state/'status.json')
        health['last_attempt'] = time.time()
        try:
            if run(['git', 'status', '--porcelain'], cwd=repo):
                raise RuntimeError('Unpublished local edits; commit/push or stash them before refreshing.')
            run(['git', 'pull', '--ff-only'], cwd=repo, timeout=15)
            data = manifest(repo)
            backup = state/('sync-backup-'+str(time.time_ns()))
            current['engine'] = engine_path()
            current['managed_links'] = apply(repo, data, current['targets'], current, backup, current['engine'])
            save_json(directory/'config.json', current)
            health.update(status='current', reason=None, last_success=time.time())
            upstream_check(repo, data, force=False, quiet=True)
        except Exception as error:
            health.update(status='stale', reason=str(error))
            print('Agent setup refresh failed; cached files retained: '+str(error), file=sys.stderr)
            if not startup:
                save_json(state/'status.json', health)
                raise
        health['revision'] = run(['git', 'rev-parse', 'HEAD'], cwd=repo)
        save_json(state/'status.json', health)

def upstream_tree(upstream):
    url = upstream['repository']
    match = re.fullmatch(r'https://github.com/([^/]+/[^/]+?)(?:\.git)?', url)
    if match:
        ref = upstream.get('ref', 'main')
        endpoint = 'https://api.github.com/repos/'+match.group(1)+'/git/trees/'+ref+'?recursive=1'
        request = urllib.request.Request(endpoint, headers={'User-Agent': 'agent-backbone'})
        with urllib.request.urlopen(request, timeout=3) as response:
            result = json.load(response)
        if result.get('truncated'):
            raise RuntimeError('Upstream tree response truncated; use an explicit upstream update.')
        path = upstream.get('path', '.')
        if path == '.':
            return result['sha']
        return next(entry['sha'] for entry in result['tree'] if entry['path'] == path)
    with tempfile.TemporaryDirectory(prefix='agent-upstream-') as temp:
        clone = Path(temp)/'source'
        run(['git', 'clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', upstream.get('ref', 'main'), url, str(clone)], timeout=60)
        path = upstream.get('path', '.')
        return run(['git', 'rev-parse', 'HEAD^{tree}' if path == '.' else 'HEAD:'+path], cwd=clone)

def upstream_check(repo, data, force=True, quiet=False):
    _, _, state = paths()
    cached = read_json(state/'upstreams.json')
    for package in data.get('packages', []):
        upstream = package.get('upstream')
        if not upstream:
            continue
        name = package['name']
        old = cached.get(name, {})
        if force or old.get('approved_tree') != upstream.get('approved_tree') or time.time()-old.get('checked_at', 0) > 86400:
            try:
                latest = upstream_tree(upstream)
                old = {'checked_at': time.time(), 'latest_tree': latest,
                       'approved_tree': upstream.get('approved_tree'),
                       'status': 'current' if latest == upstream.get('approved_tree') else 'review_available'}
            except Exception:
                old = {**old, 'checked_at': time.time(), 'check_status': 'unavailable'}
            cached[name] = old
        if not quiet or old.get('status') == 'review_available':
            print(name+': '+old.get('status', 'unknown')+(' (latest check unavailable)' if old.get('check_status') else ''), file=sys.stderr if quiet else sys.stdout)
    save_json(state/'upstreams.json', cached)
    return cached

def upstream_update(name):
    package_name = name
    current = config()
    repo = Path(current['repo'])
    data = manifest(repo)
    if run(['git', 'status', '--porcelain'], cwd=repo):
        raise RuntimeError('Review existing local edits before updating upstream packages.')
    package = next((p for p in data.get('packages', []) if p['name'] == name), None)
    if not package or not package.get('upstream'):
        raise RuntimeError('No upstream is configured for package '+name)
    upstream = package['upstream']
    path = upstream.get('path', '.')
    if Path(path).is_absolute() or '..' in Path(path).parts:
        raise RuntimeError('Invalid upstream package path.')
    _, _, state = paths()
    with tempfile.TemporaryDirectory(prefix='agent-update-') as temp:
        clone = Path(temp)/'source'
        run(['git', 'clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', upstream.get('ref', 'main'), upstream['repository'], str(clone)], timeout=60)
        if path != '.':
            run(['git', 'sparse-checkout', 'set', path], cwd=clone)
        source = clone/path
        destination = contained(repo, package['path'])
        staged = Path(temp)/'package'
        shutil.copytree(source, staged, symlinks=True, ignore=shutil.ignore_patterns('.git'))
        for local in package.get('local_files', []):
            origin = contained(repo, str(Path(package['path'])/local), must_exist=False)
            target = staged/local
            if origin.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                if origin.is_dir():
                    shutil.copytree(origin, target, dirs_exist_ok=True, symlinks=True)
                else:
                    shutil.copy2(origin, target)
        upstream['approved_tree'] = run(['git', 'rev-parse', 'HEAD^{tree}' if path == '.' else 'HEAD:'+path], cwd=clone)
        upstream['approved_commit'] = run(['git', 'rev-parse', 'HEAD'], cwd=clone)
        # Validate links before replacement; no content may reference outside the package.
        for link in staged.rglob('*'):
            if link.is_symlink() and not link.resolve().is_relative_to(staged.resolve()):
                raise RuntimeError('Upstream package contains an external link: '+str(link.relative_to(staged)))
        count = len(list(staged.rglob('SKILL.md')))
        if not count:
            raise RuntimeError('Upstream package contains no skills.')
        view = contained(repo, data.get('skills_dir', 'skills'))
        owned_names = {entry.name for entry in view.iterdir() if entry.is_symlink() and entry.resolve().is_relative_to(destination.resolve())}
        core = staged/'skills' if (staged/'skills').is_dir() else staged
        candidates = [(package_name, core)] if (core/'SKILL.md').exists() else [(skill.parent.name, skill.parent) for skill in core.rglob('SKILL.md')]
        candidate_names = []
        for candidate, skill_directory in candidates:
            if candidate in candidate_names or ((view/candidate).exists() or (view/candidate).is_symlink()) and candidate not in owned_names:
                raise RuntimeError('New upstream skill conflicts with an existing source entry: '+candidate)
            candidate_names.append(candidate)
        provenance_file = package.get('provenance_file')
        if provenance_file:
            target = staged/provenance_file
            provenance = read_json(target)
            provenance.update(repository=upstream['repository'], commit=upstream['approved_commit'], upstream_tree=upstream['approved_tree'])
            plugin_manifest = staged/'plugin.json'
            if plugin_manifest.exists():
                provenance['version'] = read_json(plugin_manifest).get('version', provenance.get('version'))
            save_json(target, provenance)
        backup = state/('upstream-backup-'+str(time.time_ns()))
        backup.mkdir(parents=True)
        destination.rename(backup/name)
        shutil.copytree(staged, destination, symlinks=True)
    # Refresh the package's approved source view, including new and removed skills.
    view = contained(repo, data.get('skills_dir', 'skills'))
    for entry in list(view.iterdir()):
        if entry.is_symlink() and entry.resolve().is_relative_to(destination.resolve()):
            entry.unlink()
    for candidate, skill_directory in candidates:
        target = view/candidate
        if target.exists() or target.is_symlink():
            raise RuntimeError('New upstream skill conflicts with existing source entry: '+candidate)
        actual_directory = destination/skill_directory.relative_to(staged)
        target.symlink_to(os.path.relpath(actual_directory, view), target_is_directory=True)
    save_json(repo/'backbone.json', data)
    print('Updated '+package_name+' locally; host adapters preserved. Review the Git diff, commit and push to publish.')
    print(run(['git', 'diff', '--stat'], cwd=repo))

def inventory():
    home, _, _ = paths()
    by_name = {}
    visited = set()
    installed_sources = {}
    for relative in SKILL_ROOTS.values():
        root = home/relative
        for lock in [root.parent/'.skill-lock.json', root.resolve().parent/'.skill-lock.json']:
            if lock.exists():
                for name, item in read_json(lock).get('skills', {}).items():
                    if isinstance(item, dict):
                        installed_sources[name] = {key: item.get(key) for key in ['source', 'sourceType', 'skillPath'] if key in item}
    for agent, relative in {**SKILL_ROOTS, 'codex-legacy': '.codex/skills'}.items():
        root = home/relative
        if not root.exists():
            continue
        for directory, dirs, files in os.walk(root, followlinks=True):
            real = str(Path(directory).resolve())
            if real in visited:
                dirs[:] = []
                continue
            visited.add(real)
            dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ['node_modules', '__pycache__', 'backups']]
            if 'SKILL.md' not in files:
                continue
            skill = Path(directory)/'SKILL.md'
            content = skill.read_text(errors='replace')
            match = re.search(r'^name:\s*(.*?)\s*$', content, re.M)
            name = match.group(1).strip('"\'') if match else skill.parent.name
            by_name.setdefault(name, []).append({'agent': agent, 'path': str(skill), 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'installer_source': installed_sources.get(skill.parent.name)})
    duplicates = {name: values for name, values in by_name.items() if len(values) > 1}
    print(json.dumps({'skills': by_name, 'duplicates': duplicates,
                      'conflicting_instructions': [name for name, values in duplicates.items() if len({v['sha256'] for v in values}) > 1]}, indent=2))

def adopt(source, name):
    current = config()
    repo = Path(current['repo'])
    data = manifest(repo)
    origin = Path(source).expanduser().resolve()
    if not (origin/'SKILL.md').exists() or not re.fullmatch(r'[a-z0-9][a-z0-9-]*', name):
        raise RuntimeError('Adopt a complete skill directory with a lowercase slug name.')
    view = contained(repo, data.get('skills_dir', 'skills'))
    destination = repo/'packages'/name
    if destination.exists() or (view/name).exists() or (view/name).is_symlink():
        raise RuntimeError('A shared skill already uses this name.')
    for link in origin.rglob('*'):
        if link.is_symlink() and not link.resolve().is_relative_to(origin):
            raise RuntimeError('Skill references files outside its directory; adopt the complete package instead.')
    shutil.copytree(origin, destination, symlinks=True)
    (view/name).symlink_to(os.path.relpath(destination, view), target_is_directory=True)
    # skills.sh's source lock can seed provenance without handing it ownership of our files.
    for lock in [origin.parent/'.skill-lock.json', origin.parent.parent/'.skill-lock.json']:
        if not lock.exists():
            continue
        entry = read_json(lock).get('skills', {}).get(origin.name)
        if entry and entry.get('source') and entry.get('skillPath'):
            data.setdefault('packages', []).append({'name': name, 'path': str(destination.relative_to(repo)),
                                                   'upstream': {'repository': repository_url(entry['source']),
                                                                'path': str(Path(entry['skillPath']).parent), 'ref': 'main'}})
            save_json(repo/'backbone.json', data)
            break
    print('Copied full skill to '+str(destination)+'. Original installer files untouched. Review license/privacy and duplicate registrations before committing.')

def status():
    current = config()
    _, _, state = paths()
    health = read_json(state/'status.json')
    dirty = bool(run(['git', 'status', '--porcelain'], cwd=current['repo']))
    print('Agent Backbone '+VERSION)
    print('Source: '+current['repo'])
    print('Sync: '+health.get('status', 'unknown')+' | revision '+str(health.get('revision', 'unknown'))[:12])
    print('Local edits: '+('pending' if dirty else 'none'))
    print('Targets: '+', '.join(current['targets']))
    if health.get('last_success'):
        print('Last successful refresh: '+str(int(time.time()-health['last_success']))+' seconds ago')
    for name, info in read_json(state/'upstreams.json').items():
        print('Upstream '+name+': '+info.get('status', 'unknown'))

def main():
    parser = argparse.ArgumentParser(prog='agent-backbone', description='Sync skills and shared agent instructions from any Git repository.')
    parser.add_argument('--version', action='version', version='agent-backbone '+VERSION)
    sub = parser.add_subparsers(dest='command', required=True)
    configure_parser = sub.add_parser('configure')
    configure_parser.add_argument('repository')
    configure_parser.add_argument('--destination')
    configure_parser.add_argument('--agents', default='claude,codex')
    configure_parser.add_argument('--interval', type=int, default=900)
    configure_parser.add_argument('--no-background', action='store_true')
    sync_parser = sub.add_parser('sync')
    sync_parser.add_argument('--startup', action='store_true')
    sub.add_parser('status')
    sub.add_parser('inventory')
    launch_parser = sub.add_parser('launch')
    launch_parser.add_argument('agent')
    launch_parser.add_argument('arguments', nargs=argparse.REMAINDER)
    upstream_parser = sub.add_parser('upstream')
    actions = upstream_parser.add_subparsers(dest='action', required=True)
    actions.add_parser('check')
    update_parser = actions.add_parser('update')
    update_parser.add_argument('name')
    adopt_parser = sub.add_parser('adopt')
    adopt_parser.add_argument('source')
    adopt_parser.add_argument('--name', required=True)
    engine_parser = sub.add_parser('skillshare')
    engine_parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.command == 'configure':
            if args.interval < 60:
                raise RuntimeError('Refresh interval must be at least 60 seconds.')
            configure(args)
        elif args.command == 'sync':
            sync(args.startup)
        elif args.command == 'status':
            status()
        elif args.command == 'inventory':
            inventory()
        elif args.command == 'upstream':
            current = config()
            repo = Path(current['repo'])
            upstream_check(repo, manifest(repo)) if args.action == 'check' else upstream_update(args.name)
        elif args.command == 'adopt':
            adopt(args.source, args.name)
        elif args.command == 'launch':
            current = config()
            if args.agent not in current['agents']:
                raise RuntimeError('Agent executable was not registered during configuration.')
            with contextlib.redirect_stdout(sys.stderr):
                sync(startup=True)
            arguments = args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments
            os.execv(current['agents'][args.agent], [current['agents'][args.agent], *arguments])
        elif args.command == 'skillshare':
            current = config()
            os.environ['SKILLSHARE_CONFIG'] = str(paths()[1]/'skillshare.yaml')
            engine = engine_path()
            os.execv(engine, [engine, *args.arguments])
    except (RuntimeError, ValueError, KeyError, OSError) as error:
        print('agent-backbone: '+str(error), file=sys.stderr)
        raise SystemExit(1)

if __name__ == '__main__':
    main()
