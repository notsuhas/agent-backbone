"""Bounded startup refresh; use a private local Git checkout and native symlinks."""
import argparse, fcntl, json, os, signal, subprocess, time
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('--binary',required=True)
parser.add_argument('--repo',required=True)
parser.add_argument('--state',required=True)
parser.add_argument('--timeout',type=float,default=20)
args=parser.parse_args()
state=Path(args.state);state.parent.mkdir(parents=True,exist_ok=True)
try: previous=json.loads(state.read_text())
except (OSError,ValueError): previous={}
def revision():
    p=subprocess.run(['git','-C',args.repo,'rev-parse','HEAD'],capture_output=True,text=True,timeout=5)
    return p.stdout.strip() if p.returncode==0 else None
with state.with_suffix('.lock').open('a') as lock:
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        print('Skill refresh already running; using current local library.')
        raise SystemExit(0)
    result={**previous,'last_attempt':time.time(),'revision':revision()}
    env=os.environ.copy();env.update(GIT_TERMINAL_PROMPT='0',GCM_INTERACTIVE='never')
    try:
        process=subprocess.Popen([args.binary,'pull'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:
            stdout,stderr=process.communicate(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.communicate()
            raise
        if process.returncode:
            result.update(status='stale',reason=(stderr or stdout).strip()[-1500:])
        else:
            result.update(status='current',reason=None,last_success=time.time(),revision=revision())
    except subprocess.TimeoutExpired:
        result.update(status='stale',reason='Refresh timed out; cached skills retained.')
    except OSError as error:
        result.update(status='stale',reason=str(error))
    pending=state.with_suffix('.tmp');pending.write_text(json.dumps(result,indent=2));pending.replace(state)
    if result['status']=='stale':
        print('Skill refresh failed; using cached revision '+str(result['revision'])[:12]+'. Check '+str(state)+'.')
    checker=Path(__file__).with_name('check_upstream.py')
    if checker.exists():
        try:
            check=subprocess.run(['python3',str(checker),'--state',str(state.with_name('upstream-status.json'))],capture_output=True,text=True,timeout=4)
            if check.stdout:print(check.stdout.rstrip())
        except (OSError,subprocess.TimeoutExpired):pass
