"""Refresh before starting an agent; keep stdout clean for stdio protocols."""
import argparse, json, os, subprocess, sys

parser=argparse.ArgumentParser()
parser.add_argument('--refresh-command-json',required=True)
parser.add_argument('--agent-command-json',required=True)
parser.add_argument('agent_args',nargs=argparse.REMAINDER)
args=parser.parse_args()
refresh=json.loads(args.refresh_command_json)
agent=json.loads(args.agent_command_json)
if not isinstance(refresh,list) or not isinstance(agent,list) or not refresh or not agent:
    parser.error('commands must be nonempty JSON argument arrays')
try:
    result=subprocess.run(refresh,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=25)
    if result.stdout:print(result.stdout.rstrip(),file=sys.stderr)
    if result.stderr:print(result.stderr.rstrip(),file=sys.stderr)
    if result.returncode:print('Skill refresh failed; starting with cached skills.',file=sys.stderr)
except (OSError,subprocess.TimeoutExpired) as error:
    print('Skill refresh unavailable; starting with cached skills: '+str(error),file=sys.stderr)
extra=args.agent_args[1:] if args.agent_args[:1]==['--'] else args.agent_args
os.execvp(agent[0],agent+extra)
