"""Check public upstream trees at most daily; never upgrade automatically."""
import argparse,json,time,urllib.request
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--state',type=Path,required=True);parser.add_argument('--force',action='store_true');args=parser.parse_args()
try:state=json.loads(args.state.read_text())
except (OSError,ValueError):state={}
if args.force or time.time()-state.get('checked_at',0)>86400:
    provenance=json.loads((Path(__file__).resolve().parents[1]/'packages/pstack/PROVENANCE.json').read_text())
    request=urllib.request.Request('https://api.github.com/repos/cursor/plugins/git/trees/main',headers={'User-Agent':'skill-backbone-upstream-check'})
    try:
        with urllib.request.urlopen(request,timeout=3) as response:data=json.load(response)
        latest=next(item['sha'] for item in data['tree'] if item['path']=='pstack')
        state={'checked_at':time.time(),'status':'current' if latest==provenance['upstream_tree'] else 'review_available','approved_tree':provenance['upstream_tree'],'latest_tree':latest}
    except Exception:
        state={**state,'checked_at':time.time(),'check_status':'unavailable'}
    args.state.parent.mkdir(parents=True,exist_ok=True)
    pending=args.state.with_suffix('.tmp');pending.write_text(json.dumps(state,indent=2));pending.replace(args.state)
if state.get('status')=='review_available':print('New upstream Pstack changes available for review; approved skills retained.')
