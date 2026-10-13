import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function paths() {
  const home = process.env.HOME || os.homedir();
  return { home, directory: path.join(home, '.config/agent-backbone'), state: path.join(home, '.local/state/agent-backbone'), active: path.join(home, '.local/share/agent-backbone/active') };
}
export function exists(file: string) { return fs.existsSync(file); }
export function isLink(file: string) { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } }
export function real(file: string): string {
  if (exists(file)) return fs.realpathSync(file);
  if (isLink(file)) return real(path.resolve(path.dirname(file), fs.readlinkSync(file)));
  const parent = path.dirname(file);
  return parent === file ? file : path.join(real(parent), path.basename(file));
}
export function inside(root: string, file: string) { const relative = path.relative(real(root), real(file)); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }
export function contained(root: string, relative: string, required = true) {
  const file = path.join(root, relative);
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || !inside(root, file)) throw new Error('Manifest paths must stay within the source repository: ' + relative);
  if (required && !exists(file)) throw new Error('Manifest path missing: ' + relative);
  return file;
}
export function readJSON(file: string, fallback: unknown = {}): unknown { return exists(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
export function atomicWrite(file: string, value: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(pending, value);
  fs.renameSync(pending, file);
}
export function saveJSON(file: string, value: unknown) { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
export async function run(argv: string[], cwd?: string, timeout = 25000, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const [command, ...args] = argv;
  if (!command) throw new Error('Missing executable.');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...(cwd ? { cwd } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, timeout);
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { error += data.toString(); });
    child.on('error', (failure) => { clearTimeout(timer); reject(failure); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Command timed out; local content retained.'));
      else if (code !== 0) reject(new Error((error || output).trim().slice(-1200)));
      else resolve(output.trim());
    });
  });
}
export function commandPath() { return path.resolve(process.env.AGENT_BACKBONE_COMMAND || process.argv[1] || 'bin/agent-backbone'); }
export function which(name: string) {
  return (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name)).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}
export function enginePath() {
  const override = process.env.AGENT_BACKBONE_SKILLSHARE;
  if (override) return path.resolve(override);
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/skillshare');
  return exists(bundled) ? bundled : which('skillshare') || fail('Skillshare engine unavailable. Install Agent Backbone with Homebrew.');
}
export function fail(message: string): never { throw new Error(message); }
export function quote(value: string) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function repositoryURL(value: string) {
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) return 'https://github.com/' + value.replace(/\.git$/, '') + '.git';
  if (/^(https:\/\/|ssh:\/\/|git@)/.test(value)) {
    if (value.startsWith('https://') && new URL(value).username) throw new Error('Use a credential helper, not credentials embedded in the repository URL.');
    return value;
  }
  throw new Error('Use an existing local directory, owner/repo, or a Git URL.');
}
export function walk(root: string, follow = false): string[] {
  const result: string[] = [], visited = new Set<string>();
  function visit(dir: string) {
    if (!exists(dir) || visited.has(real(dir))) return;
    visited.add(real(dir));
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', '__pycache__', 'backups'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      result.push(file);
      if (entry.isDirectory() || (follow && entry.isSymbolicLink() && exists(file) && fs.statSync(file).isDirectory())) visit(file);
    }
  }
  visit(root);
  return result;
}
export function validateLinks(root: string, boundary = root) {
  for (const file of walk(root)) if (isLink(file) && !inside(boundary, file)) throw new Error('Package contains an external link: ' + path.relative(root, file));
}
export function digest(root: string) {
  const hash = createHash('sha256');
  for (const file of walk(root).sort()) {
    const stat = fs.lstatSync(file);
    hash.update(path.relative(root, file) + '\0' + (stat.mode & 0o777) + '\0');
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isFile()) hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
export function backupDir(prefix: string) { const dir = path.join(paths().state, prefix + '-' + randomUUID()); fs.mkdirSync(dir, { recursive: true }); return dir; }
export async function locked<T>(action: () => Promise<T>, startup = false): Promise<T | undefined> {
  const lock = path.join(paths().state, 'writer.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.mkdirSync(lock); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const owner = Number(exists(path.join(lock, 'pid')) ? fs.readFileSync(path.join(lock, 'pid'), 'utf8') : 0);
    let running = true;
    if (owner > 0) { try { process.kill(owner, 0); } catch (failure) { if (failure instanceof Error && 'code' in failure && failure.code === 'ESRCH') running = false; } }
    else running = Date.now() - fs.statSync(lock).mtimeMs < 60000;
    if (running) { if (startup) { process.stderr.write('Refresh already running; current setup retained.\n'); return; } throw new Error('Agent Backbone writer already running. Try again shortly.'); }
    fs.rmSync(lock, { recursive: true });
    return locked(action, startup);
  }
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  try { return await action(); } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}
