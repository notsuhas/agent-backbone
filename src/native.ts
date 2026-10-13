import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { roots as skillRoots } from './model.js';
import { paths } from './files.js';
import { config, manifest, sourceSkills } from './delivery.js';
import { controlPath, prepareEngine, nativeDocument, engineTarget, expandNativePath } from './engine.js';
import { enginePath, digest, contained, exists } from './files.js';
import { reconcileEngine } from './operations.js';

function fingerprint() {
  const current = config(), data = manifest(current.repo);
  const source = contained(current.repo, data.skills_dir);
  const roots = new Set([...sourceSkills(current.repo, data).values(), ...data.packages.map(pkg => contained(current.repo, pkg.path))]);
  const document = nativeDocument(controlPath());
  const resources = [document.agents_source, document.extras_source, ...Object.values(typeof document.sources === 'object' && document.sources !== null ? document.sources : {})];
  const resourceState = resources.filter((file): file is string => typeof file === 'string').map(expandNativePath).filter(exists).map(file => fs.statSync(file).isDirectory() ? digest(file) : fs.readFileSync(file, 'utf8')).join(':');
  const targetState = current.targets.map(agent => {
    const dir = engineTarget(document, agent).path || path.join(paths().home, skillRoots[agent]);
    return exists(dir) ? fs.readdirSync(dir).sort().map(name => { const file = path.join(dir, name); return name + ':' + (fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : 'foreign'); }).join(':') : '';
  }).join(':');
  return JSON.stringify(document) + digest(source) + [...roots].map(root => digest(root)).join(':') + resourceState + targetState;
}
export async function nativeCommand(args: string[]) {
  const current = config();
  await prepareEngine(current, manifest(current.repo));
  const command = args[0] || 'list';
  if (command === 'upgrade') throw new Error('Skillshare is bundled with Agent Backbone. Use brew upgrade notsuhas/tap/agent-backbone.');
  if (command === 'ui' && args.some(arg => arg === 'start')) throw new Error('Run agent-backbone ui in a terminal or tmux so its plugin adapter stays active. Use Ctrl-C to stop it.');
  let prior = fingerprint(), pending: Promise<void> | undefined;
  async function reconcile() {
    const next = fingerprint();
    if (next === prior) return;
    await reconcileEngine();
    prior = next;
  }
  const child = spawn(enginePath(), args, { stdio: 'inherit', env: { ...process.env, SKILLSHARE_CONFIG: controlPath() } });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const timer = command === 'ui' ? setInterval(() => {
    if (pending) return;
    pending = reconcile().catch(error => { process.stderr.write('Dashboard changes retained but not applied: ' + (error instanceof Error ? error.message : String(error)) + '\n'); }).finally(() => { pending = undefined; });
  }, 750) : undefined;
  try {
    const code = await new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('close', (status, signal) => resolve(status ?? (signal ? 130 : 1))); });
    if (timer) clearInterval(timer);
    if (pending) await pending;
    await reconcile();
    if (code) process.exitCode = code;
  } finally {
    if (timer) clearInterval(timer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
