"""Install the shared library on macOS/Linux, preserving replaced paths as backups."""
import argparse, hashlib, json, os, platform, shutil, subprocess, tarfile, tempfile, time
from pathlib import Path

VERSION='0.25.10'
parser=argparse.ArgumentParser()
parser.add_argument('--skillshare-binary',type=Path)
args=parser.parse_args()
repo=Path(__file__).resolve().parents[1]
home=Path.home();bin_dir=home/'.local/bin';bin_dir.mkdir(parents=True,exist_ok=True)
config_dir=home/'.config/skill-backbone';config_dir.mkdir(parents=True,exist_ok=True)
state_dir=home/'.local/state/skill-backbone';state_dir.mkdir(parents=True,exist_ok=True)
backup=state_dir/('backup-'+str(time.time_ns()));backup.mkdir()
host_file=config_dir/'host.json'
previous=json.loads(host_file.read_text()) if host_file.exists() else {}

def preserve(path,label):
    if path.exists() or path.is_symlink():
        dest=backup/label;path.rename(dest);return dest
    return None

def symlink(path,target,label):
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.is_symlink() and path.resolve()==target.resolve():return
    preserve(path,label);path.symlink_to(target,target_is_directory=True)

binary=bin_dir/'skillshare'
if args.skillshare_binary:
    candidate=args.skillshare_binary.resolve()
    if candidate != binary:
        preserve(binary,'skillshare');shutil.copy2(candidate,binary);binary.chmod(0o755)
elif not binary.exists():
    system={'Darwin':'darwin','Linux':'linux'}.get(platform.system())
    arch={'arm64':'arm64','aarch64':'arm64','x86_64':'amd64'}.get(platform.machine())
    if not system or not arch:raise SystemExit('Bootstrap currently supports macOS/Linux arm64 or amd64.')
    filename=f'skillshare_{VERSION}_{system}_{arch}.tar.gz'
    url=f'https://github.com/runkids/skillshare/releases/download/v{VERSION}/'
    with tempfile.TemporaryDirectory(prefix='skillshare-release-') as temp:
        temp=Path(temp)
        for file in [filename,'checksums.txt']:
            subprocess.run(['curl','-fsSL',url+file,'-o',str(temp/file)],check=True)
        expected=next(line.split()[0] for line in (temp/'checksums.txt').read_text().splitlines() if line.split()[-1].lstrip('*')==filename)
        if hashlib.sha256((temp/filename).read_bytes()).hexdigest()!=expected:raise SystemExit('Release checksum mismatch.')
        with tarfile.open(temp/filename) as archive:
            member=next(m for m in archive.getmembers() if Path(m.name).name=='skillshare' and m.isfile())
            binary.write_bytes(archive.extractfile(member).read());binary.chmod(0o755)

skill_config=config_dir/'skillshare.yaml'
if skill_config.exists():shutil.copy2(skill_config,backup/'skillshare.yaml')
skill_config.write_text('source: '+json.dumps(str(repo/'skills'))+'\nfollow_source_links: true\nmode: merge\ntargets:\n  codex:\n    path: '+json.dumps(str(home/'.agents/skills'))+'\nignore:\n  - .DS_Store\n  - .git/\n  - __pycache__/\n')
env=os.environ.copy();env['SKILLSHARE_CONFIG']=str(skill_config)
subprocess.run(['git','-C',str(repo),'config','pull.ff','only'],check=True)
subprocess.run([str(binary),'sync','--global'],env=env,check=True)
package=repo/'packages/pstack'
symlink(home/'.agents/packages/pstack',package,'previous-pstack-package')
symlink(home/'.claude/skills/pstack',package,'previous-claude-pstack')
# Remove duplicate legacy Codex registrations only when they point at this package.
for skill in (package/'skills').iterdir():
    old=home/'.codex/skills'/skill.name
    if old.is_symlink() and old.resolve()==skill.resolve():preserve(old,'codex-skill-'+skill.name)
for path in [home/'.codex/AGENTS.md',home/'.claude/CLAUDE.md']:
    path.parent.mkdir(parents=True,exist_ok=True)
    text=path.read_text() if path.exists() else ''
    if 'packages/pstack/HOST.md' not in text:
        preserve(path,'instructions-'+path.parent.name)
        path.write_text(text+'\nWhen using Pstack, first read '+str(home/'.agents/packages/pstack/HOST.md')+' for host compatibility. Preserve current user instructions.\n')

real={}
for agent in ['codex','claude']:
    if previous.get('agents',{}).get(agent):
        real[agent]=previous['agents'][agent]
    else:
        current=bin_dir/agent
        if current.exists() or current.is_symlink():real[agent]=str(preserve(current,'original-'+agent))
        else:
            found=shutil.which(agent)
            if found:real[agent]=found
    if agent not in real:continue
    launcher=bin_dir/agent
    launcher.write_text('#!/usr/bin/env python3\nimport json,os,sys\nfrom pathlib import Path\nhost=json.loads((Path.home()/".config/skill-backbone/host.json").read_text())\nos.environ["SKILLSHARE_CONFIG"]=host["skillshare_config"]\nrefresh=[sys.executable,host["repo"]+"/scripts/skills_refresh.py","--binary",host["skillshare_binary"],"--repo",host["repo"],"--state",host["state"]]\nos.execv(sys.executable,[sys.executable,host["repo"]+"/scripts/skills_launch.py","--refresh-command-json",json.dumps(refresh),"--agent-command-json",json.dumps([host["agents"]['+repr(agent)+']]),"--",*sys.argv[1:]])\n')
    launcher.chmod(0o755)
host={'repo':str(repo),'skillshare_config':str(skill_config),'skillshare_binary':str(binary),'state':str(state_dir/'refresh-status.json'),'agents':real,'backup':str(backup)}
host_file.write_text(json.dumps(host,indent=2)+'\n')
subprocess.run(['python3',str(repo/'scripts/skills_refresh.py'),'--binary',str(binary),'--repo',str(repo),'--state',host['state']],env=env,check=True)
print('Installed shared Pstack library and pre-launch refresh for: '+', '.join(real))
print('Backups: '+str(backup))
print('Ensure ~/.local/bin appears before other agent installations in PATH.')
