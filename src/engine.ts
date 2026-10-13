import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { roots, type Config, type Manifest } from './model.js';
import { paths, isLink, real, exists, contained, saveJSON, atomicWrite, run, enginePath } from './files.js';

const nativeSchema = z.record(z.string(), z.unknown());
const entriesSchema = z.array(z.object({ relPath: z.string(), disabled: z.boolean().default(false) }));
export function nativeDocument(file: string) { return nativeSchema.parse(exists(file) ? parse(fs.readFileSync(file, 'utf8')) : {}); }
export function controlPath() { return path.join(paths().directory, 'skillshare-control.yaml'); }
export function deliveryPath() { return path.join(paths().directory, 'skillshare.yaml'); }
export async function prepareEngine(current: Config, data: Manifest) {
  const file = controlPath(), document = nativeDocument(exists(file) ? file : deliveryPath());
  const previousDocument = JSON.stringify(document);
  const source = contained(current.repo, data.skills_dir);
  const sources = nativeSchema.parse(document.sources || {});
  delete document.source;
  document.sources = { ...sources, skills: source, agents: sources.agents || document.agents_source || path.join(current.repo, 'agents'), extras: sources.extras || document.extras_source || path.join(current.repo, 'extras') };
  delete document.agents_source; delete document.extras_source;
  document.follow_source_links = true;
  document.mode ||= 'merge'; document.ignore ||= ['.git/', '.DS_Store', '__pycache__/'];
  const targets = nativeSchema.parse(document.targets || {});
  if (!exists(file)) {
    const pluginIDs = [...fs.readdirSync(source)].filter(name => data.packages.some(pkg => pkg.claude_plugin && fs.realpathSync(path.join(source, name)).startsWith(fs.realpathSync(contained(current.repo, pkg.path)) + path.sep)));
    const claude = nativeSchema.parse(targets.claude || {});
    if (Array.isArray(claude.exclude)) claude.exclude = claude.exclude.filter(name => typeof name !== 'string' || !pluginIDs.includes(name));
    targets.claude = claude;
  }
  for (const agent of current.targets) {
    const target = nativeSchema.parse(targets[agent] || {}), settings = nativeSchema.parse(target.skills || {});
    const legacy: Record<string, unknown> = {};
    for (const key of ['path', 'include', 'exclude', 'enabled']) { if (key in target) legacy[key] = target[key]; delete target[key]; }
    targets[agent] = { ...target, skills: { path: path.join(paths().home, roots[agent]), ...legacy, ...settings } };
  }
  document.targets = targets;
  if (!document.mcp) document.mcp = { targets: current.targets };
  const mcp = nativeSchema.parse(document.mcp), sharedMCP = contained(current.repo, 'mcp.yaml', false);
  const servers = nativeSchema.parse(mcp.servers || {});
  if (!sources.mcp && exists(sharedMCP) && !Object.keys(servers).length) {
    document.sources = { ...nativeSchema.parse(document.sources), mcp: sharedMCP };
  }
  const ignoreFile = contained(current.repo, path.join(data.skills_dir, '.skillignore'), false);
  contained(current.repo, path.join(data.skills_dir, '.skillignore.local'), false);
  if (!exists(ignoreFile)) atomicWrite(ignoreFile, current.disabled_skills.join('\n') + (current.disabled_skills.length ? '\n' : ''));
  const excludePath = path.resolve(current.repo, await run(['git', 'rev-parse', '--git-path', 'info/exclude'], current.repo));
  const rules = ['/' + data.skills_dir.replaceAll(path.sep, '/') + '/.skillignore', '/' + data.skills_dir.replaceAll(path.sep, '/') + '/.skillignore.local', '/agents/.agentignore', '/agents/.agentignore.local'];
  const exclusions = exists(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  const missingRules = rules.filter(rule => !exclusions.split('\n').includes(rule));
  if (missingRules.length) atomicWrite(excludePath, exclusions.trimEnd() + '\n' + missingRules.join('\n') + '\n');
  if (!exists(file) || JSON.stringify(document) !== previousDocument) saveJSON(file, document);
  fs.chmodSync(file, 0o600);
  const defaultConfig = path.join(paths().home, '.config/skillshare/config.yaml');
  if (isLink(defaultConfig) && real(defaultConfig) === real(deliveryPath())) { fs.unlinkSync(defaultConfig); fs.symlinkSync(file, defaultConfig); }
  return document;
}
export async function engineSelection(current: Config, data: Manifest) {
  await prepareEngine(current, data);
  const result = entriesSchema.parse(JSON.parse(await run([enginePath(), 'list', '--global', '--json', '--no-tui'], undefined, 25000, { SKILLSHARE_CONFIG: controlPath() })));
  const ignored = fs.readFileSync(path.join(contained(current.repo, data.skills_dir), '.skillignore'), 'utf8').split('\n').map(line => line.trim());
  const missing = current.disabled_skills.filter(name => !result.some(entry => entry.relPath === name) && ignored.includes(name));
  return [...new Set([...result.filter(entry => entry.disabled).map(entry => entry.relPath), ...missing])].sort();
}
export async function engineToggle(current: Config, data: Manifest, changes: ReadonlyMap<string, boolean>) {
  await prepareEngine(current, data);
  const ignoreFile = path.join(contained(current.repo, data.skills_dir), '.skillignore');
  const before = fs.readFileSync(ignoreFile, 'utf8');
  try {
    for (const enabled of [true, false]) {
      const names = [...changes].filter(([, value]) => value === enabled).map(([name]) => name);
      if (names.length) await run([enginePath(), enabled ? 'enable' : 'disable', ...names, '--global'], undefined, 25000, { SKILLSHARE_CONFIG: controlPath() });
    }
    const selected = await engineSelection(current, data);
    for (const [name, enabled] of changes) if (selected.includes(name) === enabled) throw new Error('A native ignore rule overrides ' + name + '. Edit the matching glob or .skillignore.local rule first.');
    return selected;
  } catch (error) { atomicWrite(ignoreFile, before); throw error; }

}
export function expandNativePath(value: string) {
  return value.replace(/^~(?=\/|$)/, paths().home).replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g, (_, braced: string | undefined, plain: string | undefined) => process.env[braced || plain || ''] || '');
}
export function engineTarget(document: Record<string, unknown>, agent: string) {
  const targets = nativeSchema.parse(document.targets || {}), target = nativeSchema.parse(targets[agent] || {}), skills = nativeSchema.parse(target.skills || {});
  const legacy: Record<string, unknown> = {};
  for (const key of ['path', 'mode', 'include', 'exclude', 'enabled', 'flatten']) if (key in target) legacy[key] = target[key];
  const settings = { ...legacy, ...skills };
  const targetPath = z.string().optional().parse(settings.path);
  return { target, settings, enabled: settings.enabled !== false, path: targetPath ? expandNativePath(targetPath) : undefined };
}
