import { nativeDocument, controlPath, deliveryPath, engineTarget } from './engine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parse, stringify } from 'yaml';
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
  for (const instruction of data.instructions) {
    contained(repo, instruction.path);
    if (instruction.mode === 'symlink' && data.instructions.some(other => other !== instruction && other.agents.some(agent => instruction.agents.includes(agent)))) throw new Error('A linked global instruction file must be the only instruction source for its agents.');
  }
  sourceSkills(repo, data);
  return data;
}
export function sourceSkills(repo: string, data: Manifest) {
  const source = contained(repo, data.skills_dir), skills = new Map<string, string>();
  function discover(dir: string, ancestors: Set<string>) {
    if (!inside(repo, dir)) throw new Error('Skill link escapes the repository: ' + path.relative(source, dir));
    const actual = real(dir);
    if (ancestors.has(actual)) throw new Error('Source directory link cycle: ' + dir);
    if (dir !== source && exists(path.join(dir, 'SKILL.md'))) {
      validateLinks(dir, repo);
      skills.set(path.relative(source, dir).split(path.sep).join('/'), actual); return;
    }
    const next = new Set([...ancestors, actual]);
    for (const entry of fs.readdirSync(dir).sort()) {
      if (['.git', 'node_modules', '__pycache__'].includes(entry)) continue;
      const child = path.join(dir, entry);
      if (exists(child) && fs.statSync(child).isDirectory()) discover(child, next);
    }
  }
  discover(source, new Set());
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
function prefixedMetadata(content: string, prefix: string) {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!header) throw new Error('Prefixed skill metadata is missing.');
  const metadata = z.object({ name: z.string().min(1) }).passthrough().parse(parse(header[1]!));
  return '---\n' + stringify({ ...metadata, name: prefix + '-' + metadata.name }) + '---\n' + content.slice(header[0].length);
}
function projection(repo: string, data: Manifest, disabled: Set<string>) {
  const skills = sourceSkills(repo, data), activeSkills = new Map<string, string>(), packages = new Map<string, string>();
  const fingerprintsFile = path.join(paths().state, 'projections.json');
  const fingerprints = projectionSchema.parse(readJSON(fingerprintsFile));
  for (const pkg of data.packages) {
    const source = real(contained(repo, pkg.path));
    const members = [...skills].filter(([, dir]) => inside(source, dir));
    const enabled = members.filter(([name]) => !disabled.has(name));
    if (members.length && !enabled.length) continue;
    const key = createHash('sha256').update(digest(source)).update(JSON.stringify(members.map(([name]) => [name, disabled.has(name)]))).update(pkg.skill_prefix || '').digest('hex');
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
        else if (pkg.skill_prefix) fs.writeFileSync(skillFile, prefixedMetadata(fs.readFileSync(skillFile, 'utf8'), pkg.skill_prefix));
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
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(dir, link, 'dir');
  }
  const librarySource = contained(repo, data.skills_dir);
  for (const id of activeSkills.keys()) {
    const top = id.split('/')[0];
    if (!top || !top.startsWith('_')) continue;
    const metadata = path.join(librarySource, top, '.git'), link = path.join(sourceView, top, '.git');
    if (exists(metadata) && !exists(link)) { fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(metadata, link); }
  }
  const expected = new Set<string>();
  for (const name of activeSkills.keys()) {
    let file = path.join(sourceView, name);
    while (file !== sourceView) { expected.add(file); file = path.dirname(file); }
  }
  if (walk(sourceView).some(file => !expected.has(file))) throw new Error('Generated source view has unmanaged content: ' + sourceView);
  return { skills: activeSkills, packages, sourceView };
}
async function selectedForTarget(options: { repo: string; data: Manifest; agent: Agent; settings: Record<string, unknown>; engine: string; ignore: unknown; targetNaming: unknown }) {
  const { repo, data, agent, settings, engine, ignore, targetNaming } = options;
  const source = contained(repo, data.skills_dir), skills = sourceSkills(repo, data);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-filter-'));
  try {
    const target = path.join(temp, 'target'), file = path.join(temp, 'config.yaml');
    const prefixed = (settings.target_naming || targetNaming) === 'prefixed';
    const probeSource = prefixed ? path.join(temp, 'source') : source;
    if (prefixed) {
      for (const [id, canonical] of skills) {
        const stub = path.join(probeSource, id);
        atomicWrite(path.join(stub, 'SKILL.md'), fs.readFileSync(path.join(canonical, 'SKILL.md'), 'utf8'));
        atomicWrite(path.join(stub, 'BACKBONE_SOURCE_ID'), id);
      }
      for (const entry of walk(source).filter(file => ['.skillignore', '.skillignore.local', '.skillshare-targets.json'].includes(path.basename(file)))) {
        atomicWrite(path.join(probeSource, path.relative(source, entry)), fs.readFileSync(entry, 'utf8'));
      }
      for (const top of fs.readdirSync(source).filter(name => name.startsWith('_'))) {
        const metadata = path.join(source, top, '.git');
        if (exists(metadata)) { fs.mkdirSync(path.join(probeSource, top), { recursive: true }); fs.symlinkSync(metadata, path.join(probeSource, top, '.git')); }
      }
    }
    saveJSON(file, { sources: { skills: probeSource }, follow_source_links: true, mode: 'merge', target_naming: targetNaming || 'flat', ignore: ignore || [], targets: { [agent]: { skills: { ...settings, path: target, mode: prefixed ? 'copy' : 'merge', enabled: true } } } });
    await run([engine, 'sync', 'skills', '--global'], undefined, 25000, { SKILLSHARE_CONFIG: file });
    const selected = new Map<string, string>();
    for (const name of exists(target) ? fs.readdirSync(target) : []) {
      const link = path.join(target, name);
      if (prefixed) {
        const marker = path.join(link, 'BACKBONE_SOURCE_ID');
        if (exists(marker)) { const id = fs.readFileSync(marker, 'utf8'); if (skills.has(id)) selected.set(id, name); }
        continue;
      }
      if (!isLink(link)) continue;
      const lexical = path.relative(source, path.resolve(target, fs.readlinkSync(link))).split(path.sep).join('/');
      const id = skills.has(lexical) ? lexical : [...skills].find(([id, canonical]) => canonical === real(link) && (id === name || !selected.has(id)))?.[0];
      if (id) selected.set(id, name);
    }
    return selected;
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
  const selections = new Map<Agent, Map<string, string>>(), deliveries = new Map<Agent, ReturnType<typeof projection>>();
  const allSkills = sourceSkills(repo, data);
  for (const agent of activeAgents) {
    const selected = await selectedForTarget({ repo, data, agent, settings: engineTarget(native, agent).settings, engine, ignore: native.ignore, targetNaming: native.target_naming });
    selections.set(agent, selected);
    const omitted = new Set([...disabled, ...[...allSkills.keys()].filter(name => !selected.has(name))]);
    deliveries.set(agent, projection(repo, data, omitted));
  }
  const desired: Record<string, string> = {};
  for (const agent of activeAgents) for (const [name, source] of deliveries.get(agent)?.skills || []) if (agent !== 'claude' || !pluginSkills.has(name)) desired[path.join(rootFor(agent), selections.get(agent)?.get(name) || name)] = source;
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
  const notes = new Map<string, { actual: string; text: string; cleaned: string; policy: string; shared: string[]; agent: string }>();
  for (const agent of agents) {
    if (data.instructions.some(entry => entry.mode === 'symlink' && entry.agents.includes(agent))) continue;
    const noteRelative = instructionFiles[agent];
    if (!noteRelative) continue;
    const file = path.join(home, noteRelative), actual = isLink(file) ? real(file) : file;
    const text = exists(actual) ? fs.readFileSync(actual, 'utf8') : '';
    validateBlock(text, file);
    const chunks: string[] = [];
    for (const pkg of data.packages) if (pkg.host_notes && delivery.packages.has(pkg.name)) chunks.push('When using ' + pkg.name + ', first read ' + path.join(home, '.agents/packages', pkg.name, pkg.host_notes) + ' for host compatibility. Preserve current user instructions.');
    if (!activeAgents.includes(agent)) chunks.push('Skill delivery is disabled for this agent. Do not load shared skills through source caches or sibling references.');
    const selected = selections.get(agent);
    const omitted = [...new Set([...disabled, ...[...allSkills.keys()].filter(name => selected && !selected.has(name))])].sort();
    if (omitted.length) chunks.push('Disabled skills: ' + omitted.join(', ') + '. Do not load or invoke these skills, including through sibling references or source caches.');
    const cleaned = text.replace(/<!-- agent-backbone:begin -->[\s\S]*?<!-- agent-backbone:end -->\n?/, '').trimEnd();
    const policy = chunks.join('\n\n') + '\n';
    const shared = data.instructions.filter(entry => entry.agents.includes(agent)).map(entry => entry.path);
    if (notes.has(actual) && (notes.get(actual)?.policy !== policy || JSON.stringify(shared) !== JSON.stringify(notes.get(actual)?.shared))) throw new Error('Agents share one instruction file but need different content: ' + actual);
    notes.set(actual, { actual, text, cleaned: text.includes(START) ? cleaned + '\n' : text, policy, shared, agent });
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
    const excludes = [...z.array(z.string()).parse(settings.exclude || []), ...[...allSkills.keys()].filter(id => !selections.get(agent)?.has(id))];
    targets[agent] = { ...engineTarget(native, agent).target, skills: { ...settings, path: rootFor(agent), enabled: activeAgents.includes(agent), ...(agent === 'claude' ? { exclude: [...new Set([...excludes, ...pluginSkills])].sort() } : {}) } };
  }
  const sources = z.record(z.string(), z.unknown()).parse(native.sources || {});
  const extras = z.array(z.record(z.string(), z.unknown())).parse(native.extras || []).filter(extra => typeof extra.name !== 'string' || !extra.name.startsWith('agent-backbone-'));
  for (const [index, instruction] of data.instructions.entries()) {
    const source = contained(repo, instruction.path);
    const targets = agents.filter(agent => instruction.agents.includes(agent)).flatMap(agent => {
      const relative = instructionFiles[agent];
      if (!relative) return [];
      return [{ path: path.dirname(path.join(home, relative)), as: path.basename(relative), mode: instruction.mode }];
    });
    if (targets.length) extras.push({ name: 'agent-backbone-instructions-' + index, source: path.dirname(source), file: path.basename(source), targets });
  }
  for (const note of notes.values()) {
    const id = createHash('sha256').update(note.actual).digest('hex').slice(0, 16);
    const source = path.join(paths().state, 'instructions', id + '.md');
    if (!exists(source) || fs.readFileSync(source, 'utf8') !== note.policy) atomicWrite(source, note.policy);
    extras.push({ name: 'agent-backbone-access-' + id, source: path.dirname(source), file: path.basename(source), targets: [{ path: path.dirname(note.actual), as: path.basename(note.actual), mode: 'append' }] });
  }
  const updatedNative = { ...native, extras };
  if (JSON.stringify(updatedNative) !== JSON.stringify(native)) saveJSON(controlPath(), updatedNative);
  fs.chmodSync(controlPath(), 0o600);
  const skillConfig = deliveryPath();
  saveJSON(skillConfig, { ...updatedNative, sources: { ...sources, skills: delivery.sourceView }, follow_source_links: true, mode: native.mode || 'merge', targets });
  fs.chmodSync(skillConfig, 0o600);
  for (const note of notes.values()) if (note.text !== note.cleaned) {
    if (exists(note.actual)) fs.copyFileSync(note.actual, path.join(backup, note.agent + '-instructions.md'));
    atomicWrite(note.actual, note.cleaned);
  }
  try {
    await run([engine, 'sync', 'mcp', '--global'], undefined, 25000, { SKILLSHARE_CONFIG: controlPath() });
    for (const resource of [[], ['agents'], ['extras'], ['hooks']]) await run([engine, 'sync', ...resource, '--global'], undefined, 25000, { SKILLSHARE_CONFIG: skillConfig });
  }
  catch (error) { for (const note of notes.values()) if (note.text !== note.cleaned) atomicWrite(note.actual, note.text); throw error; }
  return Object.fromEntries(Object.entries(desired).map(([target, source]) => [target, real(source)]));
}
