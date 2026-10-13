import * as fs from 'node:fs';
import * as path from 'node:path';
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
  if (!isLink(target)) return false;
  const recorded = previous?.managed_links[target];
  if (recorded) return real(target) === real(recorded);
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
function validateBlock(text: string, file: string) {
  const starts = text.split(START).length - 1, ends = text.split(END).length - 1;
  if (starts !== ends || starts > 1 || (starts === 1 && text.indexOf(START) > text.indexOf(END))) throw new Error('Malformed managed instruction block: ' + file);
}
export async function apply(options: { repo: string; data: Manifest; agents: Agent[]; previous?: Config; backup: string; engine: string; disabled: string[] }) {
  const { repo, data, agents, previous, backup, engine, disabled } = options;
  const { home, directory } = paths();
  const delivery = projection(repo, data, new Set(disabled)), pluginSkills = new Set<string>();
  for (const pkg of data.packages.filter(pkg => pkg.claude_plugin)) {
    const source = contained(repo, pkg.path);
    for (const [name, dir] of sourceSkills(repo, data)) if (inside(source, dir)) pluginSkills.add(name);
  }
  if (pluginSkills.size && agents.includes('claude') && agents.some(agent => agent !== 'claude' && real(path.join(home, roots[agent])) === real(path.join(home, roots.claude)))) throw new Error('Claude shares its skill root with another agent. Full-plugin delivery needs separate roots; existing dotfiles are untouched.');
  const desired: Record<string, string> = {};
  for (const agent of agents) for (const [name, source] of delivery.skills) if (agent !== 'claude' || !pluginSkills.has(name)) desired[path.join(home, roots[agent], name)] = source;
  for (const pkg of data.packages) {
    const source = delivery.packages.get(pkg.name);
    if (!source) continue;
    desired[path.join(home, '.agents/packages', pkg.name)] = source;
    if (pkg.claude_plugin && agents.includes('claude')) desired[path.join(home, roots.claude, pkg.name)] = source;
  }
  for (const [target, source] of Object.entries(desired)) {
    if (!exists(target) && !isLink(target)) continue;
    if (isLink(target) && real(target) === real(source)) continue;
    if (!owned(target, previous)) throw new Error('Unmanaged destination conflicts with shared content: ' + target);
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
    if (disabled.length) chunks.push('Disabled skills: ' + disabled.join(', ') + '. Do not load or invoke these skills, including through sibling references or source caches.');
    const cleaned = text.replace(/<!-- agent-backbone:begin -->[\s\S]*?<!-- agent-backbone:end -->\n?/, '').trimEnd();
    const updated = (cleaned ? cleaned + '\n\n' : '') + START + '\n\n' + chunks.join('\n\n') + '\n\n' + END + '\n';
    if (notes.has(actual) && notes.get(actual)?.updated !== updated) throw new Error('Agents share one instruction file but need different content: ' + actual);
    notes.set(actual, { actual, text, updated, agent });
  }
  fs.mkdirSync(backup, { recursive: true });
  const backupLink = (target: string) => fs.renameSync(target, path.join(backup, path.relative(home, target).replaceAll(path.sep, '__')));
  for (const [target, source] of Object.entries(previous?.managed_links || {})) if (!(target in desired) && isLink(target) && real(target) === real(source)) backupLink(target);
  for (const [target, source] of Object.entries(desired)) {
    if (isLink(target) && real(target) === real(source)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (exists(target) || isLink(target)) backupLink(target);
    fs.symlinkSync(source, target, 'dir');
  }
  const targets: Record<string, { path: string; exclude?: string[] }> = {};
  for (const agent of agents) targets[agent] = { path: path.join(home, roots[agent]), ...(agent === 'claude' && pluginSkills.size ? { exclude: [...pluginSkills].sort() } : {}) };
  const skillConfig = path.join(directory, 'skillshare.yaml');
  saveJSON(skillConfig, { source: delivery.sourceView, follow_source_links: true, mode: 'merge', targets, ignore: ['.git/', '.DS_Store', '__pycache__/'] });
  await run([engine, 'sync', '--global'], undefined, 25000, { SKILLSHARE_CONFIG: skillConfig });
  for (const note of notes.values()) if (note.text !== note.updated) {
    if (exists(note.actual)) fs.copyFileSync(note.actual, path.join(backup, note.agent + '-instructions.md'));
    atomicWrite(note.actual, note.updated);
  }
  return Object.fromEntries(Object.entries(desired).map(([target, source]) => [target, real(source)]));
}
