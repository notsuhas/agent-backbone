import { nativeDocument, controlPath, deliveryPath, engineTarget } from './engine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { configSchema, manifestSchema, roots, instructionFiles, type Agent, type Config, type Manifest } from './model.js';
import { paths, readJSON, contained, real, inside, exists, isLink, walk, digest, validateLinks, saveJSON, atomicWrite, run } from './files.js';

const START = '<!-- agent-backbone:begin -->', END = '<!-- agent-backbone:end -->';
export function config(): Config {
  const file = path.join(paths().directory, 'config.json');
  if (!exists(file)) throw new Error('Run agent-backbone configure <repository> first.');
  return configSchema.parse(readJSON(file));
}
export function previousConfig(): Config | undefined {
  for (const file of [path.join(paths().directory, 'config.json'), path.join(paths().home, '.config/skill-backbone/host.json')]) {
    if (exists(file)) return configSchema.parse(readJSON(file));
  }
  return;
}
export function manifest(repo: string): Manifest {
  const data = manifestSchema.parse(readJSON(path.join(repo, 'backbone.json'), { schema_version: 1 }));
  contained(repo, data.skills_dir);
  const names = new Set<string>();
  for (const pkg of data.packages) {
    if (names.has(pkg.name)) throw new Error('Package names must be unique lowercase slugs.');
    names.add(pkg.name);
    const root = contained(repo, pkg.path);
    validateLinks(root);
    for (const local of pkg.local_files) contained(repo, path.join(pkg.path, local), false);
    if (pkg.host_notes) contained(repo, path.join(pkg.path, pkg.host_notes));
    if (pkg.provenance_file) contained(repo, path.join(pkg.path, pkg.provenance_file), false);
    if (pkg.upstream) contained(repo, pkg.upstream.path, false);
  }
  for (const instruction of data.instructions) contained(repo, instruction.path);
  sourceSkills(repo, data);
  return data;
}
export function sourceSkills(repo: string, data: Manifest) {
  const source = contained(repo, data.skills_dir), skills = new Map<string, string>();
  for (const entry of fs.readdirSync(source)) {
    const dir = path.join(source, entry);
    if (exists(path.join(dir, 'SKILL.md')) && fs.statSync(dir).isDirectory()) {
      if (!inside(repo, dir)) throw new Error('Skill link escapes the repository: ' + entry);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(entry)) throw new Error('Skill IDs must be lowercase slugs: ' + entry);
      validateLinks(dir, repo);
      skills.set(entry, real(dir));
    }
  }
  return skills;
}
function owned(target: string, previous?: Config) {
  if (!isLink(target)) {
    const hash = previous?.managed_copies[target];
    const source = previous?.managed_links[target];
        if (!exists(target) || !fs.statSync(target).isDirectory()) return false;
    if (hash) return digest(target) === hash;
    if (!source) return false;
    const canonical = previous ? sourceSkills(previous.repo, manifest(previous.repo)).get(path.basename(target)) : undefined;
    return (exists(source) && digest(target) === digest(source)) || (!!canonical && digest(target) === digest(canonical));
  }
  const recorded = previous?.managed_links[target];
  if (recorded) return real(target) === real(recorded) || (!!previous && inside(previous.repo, target));
  return !!previous && inside(previous.repo, target);
}
const projectionSchema = z.record(z.string(), z.string());
function projection(repo: string, data: Manifest, disabled: Set<string>) {
  const skills = sourceSkills(repo, data), activeSkills = new Map<string, string>(), packages = new Map<string, string>();
  const fingerprintsFile = path.join(paths().state, 'projections.json');
  const fingerprints = projectionSchema.parse(readJSON(fingerprintsFile));
  for (const pkg of data.packages) {
    const source = real(contained(repo, pkg.path));
    const members = [...skills].filter(([, dir]) => inside(source, dir));
    const enabled = members.filter(([name]) => !disabled.has(name));
    if (members.length && !enabled.length) continue;
    const key = createHash('sha256').update(digest(source)).update(JSON.stringify(members.map(([name]) => [name, disabled.has(name)]))).digest('hex');
    const target = path.join(paths().active, pkg.name, key);
    if (!exists(target)) {
      const pending = target + '.tmp-' + process.pid;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(pending, { recursive: true, force: true });
      fs.cpSync(source, pending, { recursive: true, verbatimSymlinks: true });
      const enabledDirs = new Set(enabled.map(([, dir]) => real(dir)));
      for (const skillFile of walk(pending).filter(file => path.basename(file) === 'SKILL.md')) {
        const relative = path.relative(pending, path.dirname(skillFile));
        if (!enabledDirs.has(real(path.join(source, relative)))) fs.rmSync(path.dirname(skillFile), { recursive: true, force: true });
      }
      validateLinks(pending);
      fs.renameSync(pending, target);
      fingerprints[target] = digest(target);
      saveJSON(fingerprintsFile, fingerprints);
    } else if (!fingerprints[target] || fingerprints[target] !== digest(target)) {
      throw new Error('Generated skill view was edited: ' + target + '. Keep edits in the source repository; restore this view before refreshing.');
    }
    packages.set(pkg.name, target);
    for (const [name, dir] of enabled) activeSkills.set(name, path.join(target, path.relative(source, dir)));
  }
  for (const [name, dir] of skills) if (!disabled.has(name) && !activeSkills.has(name) && !data.packages.some(pkg => inside(contained(repo, pkg.path), dir))) activeSkills.set(name, dir);
  const key = createHash('sha256').update(JSON.stringify([...activeSkills])).digest('hex');
  const sourceView = path.join(paths().active, 'views', key);
  fs.mkdirSync(sourceView, { recursive: true });
  for (const [name, dir] of activeSkills) {
    const link = path.join(sourceView, name);
    if (isLink(link) && real(link) === real(dir)) continue;
    if (exists(link) || isLink(link)) throw new Error('Generated source view was edited: ' + link);
    fs.symlinkSync(dir, link, 'dir');
  }
  if (fs.readdirSync(sourceView).some(name => !activeSkills.has(name))) throw new Error('Generated source view has unmanaged content: ' + sourceView);
  return { skills: activeSkills, packages, sourceView };
}
async function selectedForTarget(repo: string, data: Manifest, settings: Record<string, unknown>, engine: string, ignore: unknown) {
  const include = z.array(z.string()).parse(settings.include || []), exclude = z.array(z.string()).parse(settings.exclude || []);
  const skills = sourceSkills(repo, data);
  if (!include.length && !exclude.length) return new Set(skills.keys());
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-filter-'));
  try {
    const target = path.join(temp, 'target'), file = path.join(temp, 'config.yaml');
    saveJSON(file, { sources: { skills: contained(repo, data.skills_dir) }, follow_source_links: true, mode: 'merge', ignore: ignore || [], targets: { probe: { skills: { ...settings, path: target, enabled: true } } } });
    await run([engine, 'sync', 'skills', '--global'], undefined, 25000, { SKILLSHARE_CONFIG: file });
    return new Set(exists(target) ? fs.readdirSync(target).filter(name => skills.has(name)) : []);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function validateBlock(text: string, file: string) {
  const starts = text.split(START).length - 1, ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts === 1 && text.indexOf(START) > text.indexOf(END))) throw new Error('Malformed managed instruction block: ' + file);
}
export async function apply(options: { repo: string; data: Manifest; agents: Agent[]; previous?: Config; backup: string; engine: string; disabled: string[] }) {
  const { repo, data, agents, previous, backup, engine, disabled } = options;
  const { home } = paths();
  const native = nativeDocument(controlPath());
  const activeAgents = agents.filter(agent => engineTarget(native, agent).enabled);
  const rootFor = (agent: Agent) => engineTarget(native, agent).path || path.join(home, roots[agent]);
  const delivery = projection(repo, data, new Set(disabled)), pluginSkills = new Set<string>();
  for (const pkg of data.packages.filter(pkg => pkg.claude_plugin)) {
    const source = contained(repo, pkg.path);
    for (const [name, dir] of sourceSkills(repo, data)) if (inside(source, dir)) pluginSkills.add(name);
  }
  if (pluginSkills.size && activeAgents.includes('claude') && activeAgents.some(agent => agent !== 'claude' && real(rootFor(agent)) === real(rootFor('claude')))) throw new Error('Claude shares its skill root with another agent. Full-plugin delivery needs separate roots; existing dotfiles are untouched.');
  const selections = new Map<Agent, Set<string>>(), deliveries = new Map<Agent, ReturnType<typeof projection>>();
  const allSkills = sourceSkills(repo, data);
  for (const agent of activeAgents) {
    const selected = await selectedForTarget(repo, data, engineTarget(native, agent).settings, engine, native.ignore);
    selections.set(agent, selected);
    const omitted = new Set([...disabled, ...[...allSkills.keys()].filter(name => !selected.has(name))]);
    deliveries.set(agent, projection(repo, data, omitted));
  }
  const desired: Record<string, string> = {};
  for (const agent of activeAgents) for (const [name, source] of deliveries.get(agent)?.skills || []) if (agent !== 'claude' || !pluginSkills.has(name)) desired[path.join(rootFor(agent), name)] = source;
  for (const pkg of data.packages) {
    const source = delivery.packages.get(pkg.name);
    if (!source) continue;
    desired[path.join(home, '.agents/packages', pkg.name)] = source;
    if (pkg.claude_plugin && activeAgents.includes('claude')) { const claudeSource = deliveries.get('claude')?.packages.get(pkg.name); if (claudeSource) desired[path.join(rootFor('claude'), pkg.name)] = claudeSource; }
  }
  for (const [target, source] of Object.entries(desired)) {
    if (!exists(target) && !isLink(target)) continue;
    if (isLink(target) && real(target) === real(source)) continue;
    if (!owned(target, previous)) throw new Error('Unmanaged destination conflicts with shared content: ' + target);
  }
  for (const target of Object.keys(previous?.managed_copies || {})) {
    if (!(target in desired) && exists(target) && !owned(target, previous)) throw new Error('Managed copy was edited: ' + target + '. Preserve those edits in your source before removing it.');
  }
  const notes = new Map<string, { actual: string; text: string; updated: string; agent: string }>();
  for (const agent of agents) {
    if (!(agent in instructionFiles)) continue;
    const noteRelative = agent === 'claude' ? instructionFiles.claude : instructionFiles.codex;
    const file = path.join(home, noteRelative), actual = isLink(file) ? real(file) : file;
    const text = exists(actual) ? fs.readFileSync(actual, 'utf8') : '';
    validateBlock(text, file);
    const chunks = data.instructions.filter(entry => entry.agents.includes(agent)).map(entry => fs.readFileSync(contained(repo, entry.path), 'utf8').trim());
    for (const pkg of data.packages) if (pkg.host_notes && delivery.packages.has(pkg.name)) chunks.push('When using ' + pkg.name + ', first read ' + path.join(home, '.agents/packages', pkg.name, pkg.host_notes) + ' for host compatibility. Preserve current user instructions.');
    if (!activeAgents.includes(agent)) chunks.push('Skill delivery is disabled for this agent. Do not load shared skills through source caches or sibling references.');
    const selected = selections.get(agent);
    const omitted = [...new Set([...disabled, ...[...allSkills.keys()].filter(name => selected && !selected.has(name))])].sort();
    if (omitted.length) chunks.push('Disabled skills: ' + omitted.join(', ') + '. Do not load or invoke these skills, including through sibling references or source caches.');
    const cleaned = text.replace(/<!-- agent-backbone:begin -->[\s\S]*?<!-- agent-backbone:end -->\n?/, '').trimEnd();
    const updated = (cleaned ? cleaned + '\n\n' : '') + START + '\n\n' + chunks.join('\n\n') + '\n\n' + END + '\n';
    if (notes.has(actual) && notes.get(actual)?.updated !== updated) throw new Error('Agents share one instruction file but need different content: ' + actual);
    notes.set(actual, { actual, text, updated, agent });
  }
  fs.mkdirSync(backup, { recursive: true });
  const backupLink = (target: string) => fs.renameSync(target, path.join(backup, path.relative(home, target).replaceAll(path.sep, '__')));
  for (const [target, source] of Object.entries(previous?.managed_links || {})) if (!(target in desired) && owned(target, previous)) backupLink(target);
  for (const name of pluginSkills) {
    const target = path.join(rootFor('claude'), name), source = sourceSkills(repo, data).get(name);
    if (source && isLink(target) && real(target) === real(source) && !(target in desired)) backupLink(target);
  }
  for (const [target, source] of Object.entries(desired)) {
    if (isLink(target) && real(target) === real(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (exists(target) || isLink(target)) backupLink(target);
    fs.symlinkSync(source, target, 'dir');
  }
  const targets = z.record(z.string(), z.unknown()).parse(native.targets || {});
  for (const agent of agents) {
    const settings = engineTarget(native, agent).settings;
    const excludes = z.array(z.string()).parse(settings.exclude || []);
    targets[agent] = { ...engineTarget(native, agent).target, skills: { ...settings, path: rootFor(agent), enabled: activeAgents.includes(agent), ...(agent === 'claude' ? { exclude: [...new Set([...excludes, ...pluginSkills])].sort() } : {}) } };
  }
  const sources = z.record(z.string(), z.unknown()).parse(native.sources || {});
  const skillConfig = deliveryPath();
  saveJSON(skillConfig, { ...native, sources: { ...sources, skills: delivery.sourceView }, follow_source_links: true, mode: native.mode || 'merge', targets });
  fs.chmodSync(skillConfig, 0o600);
  await run([engine, 'sync', '--all', '--global'], undefined, 25000, { SKILLSHARE_CONFIG: skillConfig });
  for (const note of notes.values()) if (note.text !== note.updated) {
    if (exists(note.actual)) fs.copyFileSync(note.actual, path.join(backup, note.agent + '-instructions.md'));
    atomicWrite(note.actual, note.updated);
  }
  return Object.fromEntries(Object.entries(desired).map(([target, source]) => [target, real(source)]));
}
