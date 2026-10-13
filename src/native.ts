import { dashboardProxy } from './dashboard.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { roots as skillRoots } from './model.js';
import { paths } from './files.js';
import { config, manifest, sourceSkills } from './delivery.js';
import { controlPath, prepareEngine, nativeDocument, engineTarget, expandNativePath } from './engine.js';
import { enginePath, digest, contained, exists } from './files.js';
import { reconcileEngine, sync } from './operations.js';

export async function nativeManager() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The native manager needs an interactive terminal. Use skillshare list --json for text output.');
  await nativeCommand(['list', '--global']);
}

function fingerprint() {
  const current = config(), data = manifest(current.repo);
  const source = contained(current.repo, data.skills_dir);
  const roots = new Set([...sourceSkills(current.repo, data).values(), ...data.packages.map(pkg => contained(current.repo, pkg.path))]);
  const document = nativeDocument(controlPath());
  const resources = [document.agents_source, document.extras_source, ...Object.values(typeof document.sources === 'object' && document.sources !== null ? document.sources : {})];
  resources.push(...data.instructions.map(entry => contained(current.repo, entry.path)));
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
  const project = args.some(arg => arg === '-p' || arg === '--project');
  const explicitGlobal = args.some(arg => arg === '-g' || arg === '--global');
  const localProject = ['.skillshare', 'skillshare'].some(dir => exists(path.join(process.cwd(), dir, 'config.yaml')));
  const global = !project && (explicitGlobal || !localProject);
  if (global && command === 'pull') {
    if (args.some(arg => arg === '--help' || arg === '-h')) { process.stdout.write('Usage: skillshare pull [-g|--global]\nFetch approved library content with fast-forward Git refresh and apply all resources. Force is unavailable for this managed library.\n'); return; }
    if (args.slice(1).some(arg => !['--global', '-g'].includes(arg))) throw new Error('Managed pull uses fast-forward refresh. Run skillshare pull without force or other options.');
    await sync(); return;
  }
  if (global && command === 'init' && !args.some(arg => arg === '--help' || arg === '-h')) throw new Error('This library is configured through agent-backbone configure <repository>. Use skillshare init --project for a separate project.');
  if (command === 'upgrade') throw new Error('Skillshare is bundled with Agent Backbone. Use brew upgrade notsuhas/tap/agent-backbone.');
  if (global && command === 'ui' && args.some(arg => arg === 'start')) throw new Error('Run skillshare ui in a terminal or tmux so its plugin adapter stays active. Use Ctrl-C to stop it.');
  let prior = fingerprint(), pending: Promise<void> | undefined;
  async function reconcile() {
    const next = fingerprint();
    if (next === prior) return;
    await reconcileEngine();
    prior = next;
  }
  const dashboard = global && command === 'ui' && !args.some(arg => ['--help', '-h', '--clear-cache', 'stop'].includes(arg)) ? await dashboardProxy(args.slice(1)) : undefined;
  const child = spawn(enginePath(), dashboard ? ['ui', ...dashboard.args] : args, { stdio: dashboard ? ['inherit', 'pipe', 'inherit'] : 'inherit', env: { ...process.env, SKILLSHARE_CONFIG: controlPath() } });
  if (dashboard) { process.stdout.write('Skillshare dashboard: ' + dashboard.frontURL + '\n'); child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk.toString().replaceAll(dashboard.backendURL, dashboard.frontURL))); }
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const timer = global && (command === 'ui' || (process.stdin.isTTY && process.stdout.isTTY)) ? setInterval(() => {
    if (pending) return;
    pending = reconcile().catch(error => { process.stderr.write('Skillshare changes retained but not applied: ' + (error instanceof Error ? error.message : String(error)) + '\n'); }).finally(() => { pending = undefined; });
  }, 750) : undefined;
  try {
    const code = await new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('close', (status, signal) => resolve(status ?? (signal ? 130 : 1))); });
    if (timer) clearInterval(timer);
    if (pending) await pending;
    if (global) await reconcile();
    if (code) process.exitCode = code;
  } finally {
    dashboard?.close();
    if (timer) clearInterval(timer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
