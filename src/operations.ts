import { prepareEngine, engineSelection, engineToggle } from './engine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { VERSION, roots, agentSchema, configSchema, healthSchema, checksSchema, installerSchema, type Agent, type Config } from './model.js';
import { config, previousConfig, manifest, sourceSkills, apply } from './delivery.js';
import { digest, paths, exists, real, isLink, readJSON, saveJSON, run, commandPath, enginePath, quote, repositoryURL, atomicWrite, which, backupDir, locked, walk } from './files.js';
import { upstreamCheck } from './upstream.js';
import { syncRuntimes } from './runtimes.js';
import { createHash } from 'node:crypto';
import { applySettings } from './settings.js';
import { applySubagents } from './subagents.js';

function recordCopies(current: Config) {
  const entries = Object.entries(current.managed_links).filter(([target]) => exists(target) && !isLink(target) && fs.statSync(target).isDirectory());
  current.managed_copies = Object.fromEntries(entries.map(([target]) => [target, digest(target)]));
  current.managed_source_hashes = Object.fromEntries(entries.map(([target, source]) => [target, digest(source)]));
}
interface IConfigure { repository: string; destination?: string; agents: string }
async function installIntegration(current: Config) {
  const { home } = paths(), bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const skillshare = path.join(bin, 'skillshare');
  const bridge = '#!/bin/sh\nexec ' + quote(current.command) + ' skillshare "$@"\n';
  if ((exists(skillshare) || isLink(skillshare)) && (!fs.statSync(skillshare).isFile() || fs.readFileSync(skillshare).subarray(0, 512).toString() !== bridge)) {
    fs.renameSync(skillshare, path.join(current.backup, 'original-skillshare'));
  }
  atomicWrite(skillshare, bridge); fs.chmodSync(skillshare, 0o755);
  for (const agent of current.targets) {
    if (!current.agents[agent]) continue;
    const file = path.join(bin, agent);
    atomicWrite(file, '#!/bin/sh\nexec ' + quote(current.command) + ' launch ' + quote(agent) + ' -- "$@"\n');
    fs.chmodSync(file, 0o755);
  }
  const settings = path.join(home, '.claude/settings.json');
  if (current.targets.includes('claude') && exists(settings)) fs.copyFileSync(isLink(settings) ? real(settings) : settings, path.join(current.backup, 'claude-settings.json'));
  await removeStartupRefresh();
}
function saveIfChanged(file: string, document: unknown) {
  const text = JSON.stringify(document, null, 2) + '\n';
  if (exists(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, text);
}
async function runRefreshCommands(repo: string, commands: string[]) {
  for (const command of commands) await run(['sh', '-c', command], repo, 30000).catch(error => process.stderr.write('Refresh command failed (' + command + '): ' + (error instanceof Error ? error.message : String(error)) + '\n'));
}
// Migrate installations from releases that refreshed automatically at session startup.
export async function removeStartupRefresh() {
  const { home } = paths(), helper = path.join(home, '.local/bin/agent-backbone-refresh');
  const owned = (command: unknown) => command === helper || command === helper + ' --from-claude';
  const object = z.record(z.string(), z.unknown());
  for (const [relative, event] of [
    ['.claude/settings.json', 'SessionStart'], ['.codex/hooks.json', 'SessionStart'],
    ['.cursor/hooks.json', 'sessionStart'], ['.grok/hooks/agent-backbone-refresh.json', 'SessionStart'],
  ]) {
    const file = path.join(home, relative!), target = isLink(file) ? real(file) : file;
    if (!exists(target)) continue;
    const document = object.parse(readJSON(target)), hooks = object.parse(document.hooks || {});
    if (!Array.isArray(hooks[event!])) continue;
    const entries = z.array(object).parse(hooks[event!]);
    const kept = entries.flatMap(entry => {
      if (owned(entry.command)) return [];
      if (!Array.isArray(entry.hooks)) return [entry];
      const handlers = z.array(object).parse(entry.hooks), remaining = handlers.filter(handler => !owned(handler.command));
      return remaining.length === handlers.length ? [entry] : remaining.length ? [{ ...entry, hooks: remaining }] : [];
    });
    if (JSON.stringify(kept) === JSON.stringify(entries)) continue;
    if (kept.length) hooks[event!] = kept; else delete hooks[event!];
    document.hooks = hooks;
    if (relative!.startsWith('.grok/') && !Object.keys(hooks).length && Object.keys(document).length === 1) fs.rmSync(target);
    else saveIfChanged(target, document);
  }
  for (const relative of ['.config/opencode/plugins/agent-backbone-refresh.js', '.local/bin/agent-backbone-refresh']) {
    const file = path.join(home, relative);
    if (exists(file) && (fs.readFileSync(file, 'utf8').includes('Managed by Agent Backbone') || fs.readFileSync(file, 'utf8').includes(' sync --startup'))) fs.rmSync(file);
  }
  await removeTimer();
}
// Removes the 15-minute launchd timer that versions before 0.9 installed.
async function removeTimer() {
  const label = 'ai.agent-backbone.refresh', plist = path.join(paths().home, 'Library/LaunchAgents', label + '.plist');
  if (!exists(plist)) return;
  if (process.platform === 'darwin') await run(['launchctl', 'bootout', 'gui/' + process.getuid?.() + '/' + label]).catch(() => {});
  fs.rmSync(plist, { force: true });
}
export async function configure(options: IConfigure) {
  await locked(async () => {
    const { home, directory } = paths(), previous = previousConfig();
    let repo = path.resolve(options.repository.replace(/^~(?=\/)/, home));
    if (exists(repo) && fs.statSync(repo).isDirectory()) await run(['git', 'rev-parse', '--show-toplevel'], repo);
    else {
      const url = repositoryURL(options.repository);
      repo = options.destination ? path.resolve(options.destination.replace(/^~(?=\/)/, home)) : path.join(home, '.local/share/agent-backbone/library');
      if (exists(repo)) { if (await run(['git', 'remote', 'get-url', 'origin'], repo) !== url) throw new Error('Destination already contains another source. Choose --destination.'); }
      else { fs.mkdirSync(path.dirname(repo), { recursive: true }); await run(['git', 'clone', url, repo], undefined, 60000); }
    }
    const data = manifest(repo), agents = z.array(agentSchema).nonempty().parse(options.agents.split(','));
    await run(['git', 'config', 'pull.ff', 'only'], repo);
    const backup = backupDir('backup'), engine = enginePath();
    const seed = configSchema.parse({ ...previous, repo, targets: agents, engine, command: commandPath() });
    await syncRuntimes(seed);
    await prepareEngine(seed, data);
    const disabled = await engineSelection(seed, data);
    const managed = await apply({ repo, data, agents, ...(previous ? { previous } : {}), backup, engine, disabled });
    const originals = { ...previous?.agents }, bin = path.join(home, '.local/bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const agent of agents) {
      if (originals[agent]) continue;
      const current = path.join(bin, agent), found = which(agent);
      if (exists(current) || isLink(current)) { const target = path.join(backup, 'original-' + agent); fs.renameSync(current, target); originals[agent] = target; }
      else if (found) originals[agent] = found;
    }
    const current = configSchema.parse({ repo, agents: originals, targets: agents, engine, command: commandPath(), managed_links: managed, disabled_skills: disabled, backup });
    recordCopies(current);
    saveJSON(path.join(directory, 'config.json'), current);
    await installIntegration(current);
    process.stdout.write('Configured ' + repo + ' for ' + agents.join(', ') + '. Backups: ' + backup + '\n');
  });
  await sync(true);
}
export async function sync(allowCached = false) {
  await locked(async () => {
    const current = config(), { state, directory } = paths(), health = healthSchema.parse(readJSON(path.join(state, 'status.json')));
    health.last_attempt = Date.now() / 1000;
    try {
      if (await run(['git', 'status', '--porcelain'], current.repo)) throw new Error('Unpublished local edits; commit/push or stash them before refreshing.');
      await run(['git', 'pull', '--ff-only'], current.repo, 15000);
      const data = manifest(current.repo);
      await syncRuntimes(current);
      current.engine = enginePath();
      current.disabled_skills = await engineSelection(current, data);
      current.managed_links = await apply({ repo: current.repo, data, agents: current.targets, previous: current, backup: backupDir('sync-backup'), engine: current.engine, disabled: current.disabled_skills });
      recordCopies(current);
      saveJSON(path.join(directory, 'config.json'), current);
      await applySettings(current);
      applySubagents(current);
      await runRefreshCommands(current.repo, data.refresh);
      await removeStartupRefresh();
      health.status = 'current'; health.reason = null; health.last_success = Date.now() / 1000;
      await upstreamCheck(data, false, true);
    } catch (error) {
      health.status = 'stale'; health.reason = error instanceof Error ? error.message : String(error);
      process.stderr.write('Agent setup refresh failed; cached files retained: ' + health.reason + '\n');
      saveJSON(path.join(state, 'status.json'), health);
      if (!allowCached) throw error;
    }
    health.revision = await run(['git', 'rev-parse', 'HEAD'], current.repo);
    saveJSON(path.join(state, 'status.json'), health);
  });
}
export async function reconcileEngine() {
  await locked(async () => {
    const current = config(), data = manifest(current.repo);
    current.disabled_skills = await engineSelection(current, data);
    current.managed_links = await apply({ repo: current.repo, data, agents: current.targets, previous: current, backup: backupDir('native-backup'), engine: enginePath(), disabled: current.disabled_skills });
    recordCopies(current);
    saveJSON(path.join(paths().directory, 'config.json'), current);
  });
}
async function setSkillSelection(changes: ReadonlyMap<string, boolean>) {
  if (!changes.size) return;
  await locked(async () => {
    const current = config(), data = manifest(current.repo), skills = sourceSkills(current.repo, data);
    for (const name of changes.keys()) if (!skills.has(name) && !current.disabled_skills.includes(name)) throw new Error('Unknown shared skill: ' + name + '. Use agent-backbone skills.');
    const selection = await engineToggle(current, data, changes);
    const managed = await apply({ repo: current.repo, data, agents: current.targets, previous: current, backup: backupDir('toggle-backup'), engine: enginePath(), disabled: selection });
    current.disabled_skills = selection; current.managed_links = managed;
    recordCopies(current);
    saveJSON(path.join(paths().directory, 'config.json'), current);
  });
}
export async function setEnabled(names: string[], enabled: boolean) {
  await setSkillSelection(new Map(names.map(name => [name, enabled])));
  process.stdout.write((enabled ? 'Enabled ' : 'Disabled ') + names.join(', ') + '. Disabled sources keep updating. Start a new agent session to reload skills.\n');
}
export function skills() {
  const current = config(), available = sourceSkills(current.repo, manifest(current.repo));
  const names = new Set([...available.keys(), ...current.disabled_skills]);
  for (const name of [...names].sort()) process.stdout.write((current.disabled_skills.includes(name) ? 'disabled ' : 'enabled  ') + name + (available.has(name) ? '' : ' (removed upstream)') + '\n');
}
export async function status() {
  const current = config(), health = healthSchema.parse(readJSON(path.join(paths().state, 'status.json')));
  process.stdout.write('Agent Backbone ' + VERSION + '\nSource: ' + current.repo + '\nSync: ' + (health.status || 'unknown') + ' | revision ' + (health.revision || 'unknown').slice(0, 12) + '\nLocal edits: ' + (await run(['git', 'status', '--porcelain'], current.repo) ? 'pending' : 'none') + '\nTargets: ' + current.targets.join(', ') + '\nDisabled skills: ' + (current.disabled_skills.join(', ') || 'none') + '\n');
  const tracked = new Set(manifest(current.repo).packages.flatMap(pkg => pkg.upstream ? [pkg.name] : []));
  for (const [name, info] of Object.entries(checksSchema.parse(readJSON(path.join(paths().state, 'upstreams.json')))).filter(([name]) => tracked.has(name))) process.stdout.write('Upstream ' + name + ': ' + (info.status || 'unknown') + '\n');
}
export function inventory() {
  const byName: Record<string, { agent: string; path: string; sha256: string; installer_source?: z.infer<typeof installerSchema>['skills'][string] }[]> = {}, visited = new Set<string>(), installed: z.infer<typeof installerSchema>['skills'] = {};
  for (const relative of Object.values(roots)) {
    const root = path.join(paths().home, relative);
    for (const file of [path.join(path.dirname(root), '.skill-lock.json'), path.join(path.dirname(real(root)), '.skill-lock.json')]) if (exists(file)) Object.assign(installed, installerSchema.parse(readJSON(file)).skills);
  }
  for (const [agent, relative] of Object.entries({ ...roots, 'codex-legacy': '.codex/skills' })) {
    const root = path.join(paths().home, relative);
    for (const file of walk(root, true).filter(file => path.basename(file) === 'SKILL.md' && !path.relative(root, file).split(path.sep).some(part => part.startsWith('.')))) {
      if (visited.has(real(file))) continue;
      visited.add(real(file));
      const text = fs.readFileSync(file, 'utf8'), name = /^name:\s*(.*?)\s*$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') || path.basename(path.dirname(file));
      const provenance = installed[path.basename(path.dirname(file))];
      (byName[name] ||= []).push({ agent, path: file, sha256: createHash('sha256').update(text).digest('hex'), ...(provenance ? { installer_source: provenance } : {}) });
    }
  }
  const duplicates = Object.fromEntries(Object.entries(byName).filter(([, values]) => values.length > 1));
  process.stdout.write(JSON.stringify({ skills: byName, duplicates, conflicting_skills: Object.entries(duplicates).filter(([, values]) => new Set(values.map(value => value.sha256)).size > 1).map(([name]) => name) }, null, 2) + '\n');
}
export async function launch(agent: Agent, args: string[]) {
  const registered = config().agents[agent];
  if (!registered) throw new Error('Agent executable was not registered during configuration.');
  const executable = newestVersion(registered);
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  execute(executable, forwarded);
}
// Native installers keep one binary per version in a versions folder; a registered version would pin the agent forever.
function newestVersion(executable: string) {
  const resolved = exists(executable) ? real(executable) : executable, dir = path.dirname(resolved);
  const semver = /^\d+(\.\d+)+$/, order = (name: string) => name.split('.').map(Number);
  if (path.basename(dir) !== 'versions' || !semver.test(path.basename(resolved))) return executable;
  const versions = fs.readdirSync(dir).filter(name => {
    if (!semver.test(name)) return false;
    try {
      const file = path.join(dir, name), stat = fs.statSync(file);
      fs.accessSync(file, fs.constants.X_OK);
      return stat.isFile() && stat.size > 0;
    } catch { return false; }
  });
  versions.sort((a, b) => { const x = order(a), y = order(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0; });
  return path.join(dir, versions[versions.length - 1] ?? path.basename(resolved));
}
function execute(executable: string, args: string[]): never {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  if (!process.execve) throw new Error('Node 22.16 or newer is required for agent launch integration.');
  process.execve(executable, [executable, ...args], env);
  throw new Error('Could not launch executable.');
}
