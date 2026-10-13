import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { parse } from 'yaml';
import { type Manifest, type Package, type Upstream, checksSchema, installerSchema } from './model.js';
import { manifest } from './delivery.js';
import { repositoryURL, paths, contained, inside, real, isLink, exists, readJSON, saveJSON, run, walk, validateLinks, backupDir } from './files.js';

async function clone(upstream: Upstream, destination: string) {
  await run(['git', 'clone', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', upstream.ref, upstream.repository, destination], undefined, 60000);
  if (upstream.path !== '.') await run(['git', 'sparse-checkout', 'set', '--', upstream.path], destination);
  else await run(['git', 'sparse-checkout', 'disable'], destination);
}
async function tree(upstream: Upstream) {
  const match = /^https:\/\/github.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(upstream.repository);
  if (match?.[1]) {
    const response = await fetch('https://api.github.com/repos/' + match[1] + '/git/trees/' + encodeURIComponent(upstream.ref) + '?recursive=1', { signal: AbortSignal.timeout(3000), headers: { 'User-Agent': 'agent-backbone' } });
    if (!response.ok) throw new Error('Upstream check failed: HTTP ' + response.status);
    const result = z.object({ sha: z.string(), truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), sha: z.string() })) }).parse(await response.json());
    if (result.truncated) throw new Error('Upstream tree response truncated.');
    return upstream.path === '.' ? result.sha : result.tree.find(entry => entry.path === upstream.path)?.sha || Promise.reject(new Error('Upstream path missing.'));
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-upstream-'));
  try { await clone(upstream, path.join(temp, 'source')); return await run(['git', 'rev-parse', upstream.path === '.' ? 'HEAD^{tree}' : 'HEAD:' + upstream.path], path.join(temp, 'source')); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export async function upstreamCheck(repo: string, data: Manifest, force = true, quiet = false) {
  const file = path.join(paths().state, 'upstreams.json'), cached = checksSchema.parse(readJSON(file));
  for (const pkg of data.packages) {
    const upstream = pkg.upstream;
    if (!upstream) continue;
    let old = cached[pkg.name];
    if (force || !old || old.approved_tree !== upstream.approved_tree || Date.now() / 1000 - old.checked_at > 86400) {
      try {
        const latest = await tree(upstream);
        old = { checked_at: Date.now() / 1000, latest_tree: latest, ...(upstream.approved_tree ? { approved_tree: upstream.approved_tree } : {}), status: latest === upstream.approved_tree ? 'current' : 'review_available' };
      } catch { old = { ...old, checked_at: Date.now() / 1000, check_status: 'unavailable' }; }
      cached[pkg.name] = old;
    }
    if (!quiet || old?.status === 'review_available') (quiet ? process.stderr : process.stdout).write(pkg.name + ': ' + (old?.status || 'unknown') + (old?.check_status ? ' (latest check unavailable)' : '') + '\n');
  }
  saveJSON(file, cached);
  return cached;
}
async function updatePackage(repo: string, data: Manifest, pkg: Package) {
  const upstream = pkg.upstream;
  if (!upstream) throw new Error('No upstream is configured for package ' + pkg.name);
  contained(repo, upstream.path, false);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-update-'));
  try {
    const clonePath = path.join(temp, 'source');
    await clone(upstream, clonePath);
    const approved_tree = await run(['git', 'rev-parse', upstream.path === '.' ? 'HEAD^{tree}' : 'HEAD:' + upstream.path], clonePath);
    if (approved_tree === upstream.approved_tree) { process.stdout.write(pkg.name + ': already current\n'); return false; }
    const approved_commit = await run(['git', 'rev-parse', 'HEAD'], clonePath);
    const destination = contained(repo, pkg.path), staged = path.join(temp, 'package');
    const source = contained(clonePath, upstream.path);
    fs.cpSync(source, staged, { recursive: true, verbatimSymlinks: true, filter: file => path.basename(file) !== '.git' });
    for (const local of pkg.local_files) {
      const origin = contained(repo, path.join(pkg.path, local), false), target = contained(staged, local, false);
      if (exists(origin)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(origin, target, { recursive: true, verbatimSymlinks: true }); }
    }
    validateLinks(staged);
    if (!walk(staged).some(file => path.basename(file) === 'SKILL.md')) throw new Error('Upstream package contains no skills.');
    const view = contained(repo, data.skills_dir);
    const owned = new Set(fs.readdirSync(view).filter(name => isLink(path.join(view, name)) && inside(destination, path.join(view, name))));
    const core = exists(path.join(staged, 'skills')) ? path.join(staged, 'skills') : staged;
    const candidates = exists(path.join(core, 'SKILL.md')) ? [{ name: pkg.name, relative: path.relative(staged, core) }] : walk(core).filter(file => path.basename(file) === 'SKILL.md').map(file => ({ name: path.basename(path.dirname(file)), relative: path.relative(staged, path.dirname(file)) }));
    if (pkg.skill_naming === 'frontmatter') for (const candidate of candidates) {
      const text = fs.readFileSync(path.join(staged, candidate.relative, 'SKILL.md'), 'utf8');
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
      candidate.name = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }).parse(frontmatter ? parse(frontmatter) : {}).name;
    }
    if (pkg.skill_prefix) for (const candidate of candidates) candidate.name = pkg.skill_prefix + '-' + candidate.name;
    const names = new Set<string>();
    for (const candidate of candidates) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(candidate.name) || names.has(candidate.name) || ((exists(path.join(view, candidate.name)) || isLink(path.join(view, candidate.name))) && !owned.has(candidate.name))) throw new Error('New upstream skill conflicts with an existing source entry: ' + candidate.name);
      names.add(candidate.name);
    }
    if (pkg.provenance_file) {
      const file = contained(staged, pkg.provenance_file, false);
      const provenance = z.record(z.string(), z.unknown()).parse(readJSON(file));
      const plugin = z.object({ version: z.string().optional() }).parse(readJSON(path.join(staged, 'plugin.json')));
      saveJSON(file, { ...provenance, repository: upstream.repository, commit: approved_commit, upstream_tree: approved_tree, ...(plugin.version ? { version: plugin.version } : {}) });
    }
    const upstreamPlugin = z.object({ version: z.string().optional() }).parse(readJSON(path.join(staged, 'plugin.json')));
    const adapterPath = path.join(staged, '.claude-plugin/plugin.json');
    if (pkg.claude_plugin && upstreamPlugin.version && exists(adapterPath)) {
      const adapter = z.record(z.string(), z.unknown()).parse(readJSON(adapterPath));
      saveJSON(adapterPath, { ...adapter, version: upstreamPlugin.version });
    }
    const backup = backupDir('upstream-backup');
    fs.renameSync(destination, path.join(backup, pkg.name));
    try { fs.cpSync(staged, destination, { recursive: true, verbatimSymlinks: true }); }
    catch (error) { fs.rmSync(destination, { recursive: true, force: true }); fs.renameSync(path.join(backup, pkg.name), destination); throw error; }
    for (const name of owned) fs.unlinkSync(path.join(view, name));
    for (const candidate of candidates) fs.symlinkSync(path.relative(view, path.join(destination, candidate.relative)), path.join(view, candidate.name), 'dir');
    upstream.approved_tree = approved_tree;
    upstream.approved_commit = approved_commit;
    saveJSON(path.join(repo, 'backbone.json'), data);
    process.stdout.write('Updated ' + pkg.name + ' locally; host adapters preserved. Review the Git diff before publishing.\n');
    return true;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export async function upstreamUpdate(repo: string, name?: string, all = false) {
  const data = manifest(repo);
  if (await run(['git', 'status', '--porcelain'], repo)) throw new Error('Review existing local edits before updating upstream packages.');
  const packages = all ? data.packages.filter(pkg => pkg.upstream) : data.packages.filter(pkg => pkg.name === name);
  if (!packages.length) throw new Error('No configured upstream package selected.');
  let changes = 0;
  for (const pkg of packages) if (await updatePackage(repo, data, pkg)) changes++;
  manifest(repo);
  process.stdout.write(await run(['git', 'diff', '--stat'], repo) + '\n');
  return changes;
}
export function adopt(repo: string, source: string, name: string) {
  const data = manifest(repo), origin = real(source), view = contained(repo, data.skills_dir), destination = path.join(repo, 'packages', name);
  if (!exists(path.join(origin, 'SKILL.md')) || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('Adopt a complete skill directory with a lowercase slug name.');
  if (exists(destination) || exists(path.join(view, name)) || isLink(path.join(view, name))) throw new Error('A shared skill already uses this name.');
  validateLinks(origin);
  fs.cpSync(origin, destination, { recursive: true, verbatimSymlinks: true });
  fs.symlinkSync(path.relative(view, destination), path.join(view, name), 'dir');
  for (const file of [path.join(path.dirname(origin), '.skill-lock.json'), path.join(path.dirname(path.dirname(origin)), '.skill-lock.json')]) {
    if (!exists(file)) continue;
    const item = installerSchema.parse(readJSON(file)).skills[path.basename(origin)];
    if (item?.source && item.skillPath) {
      data.packages.push({ name, path: path.relative(repo, destination), claude_plugin: false, local_files: [], upstream: { repository: repositoryURL(item.source), path: path.dirname(item.skillPath), ref: 'main' } });
      saveJSON(path.join(repo, 'backbone.json'), data);
      break;
    }
  }
  process.stdout.write('Copied full skill to ' + destination + '. Original installer files untouched. Review license/privacy and duplicate registrations before committing.\n');
}
