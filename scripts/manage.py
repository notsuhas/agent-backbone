"""Small local status/refresh interface; Skillshare commands use the owned config."""
import json,os,subprocess,sys,time
from pathlib import Path
host=json.loads((Path.home()/'.config/skill-backbone/host.json').read_text())
os.environ['SKILLSHARE_CONFIG']=host['skillshare_config']
command=sys.argv[1] if len(sys.argv)>1 else 'status'
if command=='sync':
    os.execv(sys.executable,[sys.executable,host['repo']+'/scripts/skills_refresh.py','--binary',host['skillshare_binary'],'--repo',host['repo'],'--state',host['state']])
elif command=='skillshare':
    os.execv(host['skillshare_binary'],[host['skillshare_binary'],*sys.argv[2:]])
elif command=='status':
    state=json.loads(Path(host['state']).read_text()) if Path(host['state']).exists() else {}
    upstream=Path(host['state']).with_name('upstream-status.json')
    up=json.loads(upstream.read_text()) if upstream.exists() else {}
    dirty=subprocess.run(['git','-C',host['repo'],'status','--porcelain'],capture_output=True,text=True).stdout.strip()
    age=int(time.time()-state.get('last_success',0))
    print('Library: '+state.get('status','unknown')+' | revision '+str(state.get('revision','unknown'))[:12])
    print('Last successful refresh: '+str(age)+' seconds ago')
    print('Local edits: '+('pending; publish or stash before refreshing' if dirty else 'none'))
    print('Pstack upstream: '+up.get('status','unknown'))
    if up.get('check_status')=='unavailable':print('Latest upstream check unavailable; previous result retained.')
else:raise SystemExit('Usage: skill-backbone [status | sync | skillshare <arguments>]')
