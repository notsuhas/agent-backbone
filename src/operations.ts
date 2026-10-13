import { prepareEngine, engineSelection, engineToggle } from './engine.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { VERSION, roots, agentSchema, configSchema, healthSchema, checksSchema, installerSchema, type Agent, type Config } from './model.js';
import { config, previousConfig, manifest, sourceSkills, apply } from './delivery.js';
import { digest, paths, exists, real, isLink, readJSON, saveJSON, run, commandPath, enginePath, quote, repositoryURL, atomicWrite, which, backupDir, locked, walk } from './files.js';
import { upstreamCheck } from './upstream.js';
import { syncRuntimes } from './runtimes.js';
import { createHash } from 'node:crypto';

function recordCopies(current: Config) {
  const entries = Object.entries(current.managed_links).filter(([target]) => exists(target) && !isLink(target) && fs.statSync(target).isDirectory());
  current.managed_copies = Object.fromEntries(entries.map(([target]) => [target, digest(target)]));
  current.managed_source_hashes = Object.fromEntries(entries.map(([target, source]) => [target, digest(source)]));
}
interface IConfigure { repository: string; destination?: string; agents: string; interval: number; noBackground: boolean }
async function installIntegration(current: Config, noBackground: boolean) {
  const { home, state } = paths(), bin = path.join(home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const skillshare = path.join(bin, 'skillshare');
  const bridge = '#!/bin/sh\nexec ' + quote(current.command) + ' skillshare "$@"\n';
  if ((exists(skillshare) || isLink(skillshare)) && (!fs.statSync(skillshare).isFile() || fs.readFileSync(skillshare).subarray(0, 512).toString() !== bridge)) {
    fs.renameSync(skillshare, path.join(current.backup, 'original-skillshare'));
  }
  atomicWrite(skillshare, bridge); fs.chmodSync(skillshare, 0o755);
  for (const agent of current.targets) {
    if (!current.agents[agent]) continue;
    const file = path.join(bin, agent);
    atomicWrite(file, '#!/bin/sh\nexec ' + quote(current.command) + ' launch ' + quote(agent) + ' -- "$@"\n');
    fs.chmodSync(file, 0o755);
  }
  const helper = path.join(bin, 'agent-backbone-refresh');
  atomicWrite(helper, '#!/bin/sh\nexec ' + quote(current.command) + ' sync --startup\n');
  fs.chmodSync(helper, 0o755);
  if (current.targets.includes('claude')) {
    const file = path.join(home, '.claude/settings.json'), target = isLink(file) ? real(file) : file;
    const document = z.record(z.string(), z.unknown()).parse(readJSON(target));
    const hookSchema = z.object({ hooks: z.array(z.object({ command: z.string().optional() }).passthrough()).optional() }).passthrough();
    const hooks = z.record(z.string(), z.unknown()).parse(document.hooks || {});
    const sessions = z.array(hookSchema).parse(hooks.SessionStart || []);
    const oldHelper = path.join(bin, 'skill-backbone-refresh');
    hooks.SessionStart = [...sessions.filter(entry => !(entry.hooks?.length === 1 && [helper, oldHelper].includes(entry.hooks[0]?.command || ''))), { matcher: 'startup|resume', hooks: [{ type: 'command', command: helper, timeout: 30 }] }];
    document.hooks = hooks;
    if (exists(target)) fs.copyFileSync(target, path.join(current.backup, 'claude-settings.json'));
    saveJSON(target, document);
  }
  if (!noBackground && process.platform === 'darwin') {
    const domain = 'gui/' + process.getuid?.(), label = 'ai.agent-backbone.refresh';
    await run(['launchctl', 'bootout', domain + '/ai.skill-backbone.refresh']).catch(() => {});
    fs.rmSync(path.join(home, 'Library/LaunchAgents/ai.skill-backbone.refresh.plist'), { force: true });
    const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const plist = path.join(home, 'Library/LaunchAgents', label + '.plist');
    atomicWrite(plist, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>' + label + '</string><key>ProgramArguments</key><array><string>' + escape(current.command) + '</string><string>sync</string><string>--startup</string></array><key>StartInterval</key><integer>' + current.interval + '</integer><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>' + escape(path.join(state, 'background.log')) + '</string><key>StandardErrorPath</key><string>' + escape(path.join(state, 'background-error.log')) + '</string></dict></plist>\n');
    await run(['launchctl', 'bootout', domain + '/' + label]).catch(() => {});
    await run(['launchctl', 'bootstrap', domain, plist]).catch(() => process.stderr.write('Background timer unavailable; launch refresh remains enabled.\n'));
  }
}
export async function configure(options: IConfigure) {
  await locked(async () => {
    const { home, directory } = paths(), previous = previousConfig();
    let repo = path.resolve(options.repository.replace(/^~(?=\/)/, home));
    if (exists(repo) && fs.statSync(repo).isDirectory()) await run(['git', 'rev-parse', '--show-toplevel'], repo);
    else {
      const url = repositoryURL(options.repository);
      repo = options.destination ? path.resolve(options.destination.replace(/^~(?=\/)/, home)) : path.join(home, '.local/share/agent-backbone/library');
      if (exists(repo)) { if (await run(['git', 'remote', 'get-url', 'origin'], repo) !== url) throw new Error('Destination already contains another source. Choose --destination.'); }
      else { fs.mkdirSync(path.dirname(repo), { recursive: true }); await run(['git', 'clone', url, repo], undefined, 60000); }
    }
    const data = manifest(repo), agents = z.array(agentSchema).nonempty().parse(options.agents.split(','));
    await run(['git', 'config', 'pull.ff', 'only'], repo);
    const backup = backupDir('backup'), engine = enginePath();
    const seed = configSchema.parse({ ...previous, repo, targets: agents, engine, command: commandPath() });
    await syncRuntimes(seed);
    await prepareEngine(seed, data);
    const disabled = await engineSelection(seed, data);
    const managed = await apply({ repo, data, agents, ...(previous ? { previous } : {}), backup, engine, disabled });
    const originals = { ...previous?.agents }, bin = path.join(home, '.local/bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const agent of agents) {
      if (originals[agent]) continue;
      const current = path.join(bin, agent), found = which(agent);
      if (exists(current) || isLink(current)) { const target = path.join(backup, 'original-' + agent); fs.renameSync(current, target); originals[agent] = target; }
      else if (found) originals[agent] = found;
    }
    const current = configSchema.parse({ repo, agents: originals, targets: agents, engine, command: commandPath(), managed_links: managed, disabled_skills: disabled, interval: options.interval, backup });
    recordCopies(current);
    saveJSON(path.join(directory, 'config.json'), current);
    await installIntegration(current, options.noBackground);
    process.stdout.write('Configured ' + repo + ' for ' + agents.join(', ') + '. Backups: ' + backup + '\n');
  });
  await sync(true);
}
export async function sync(startup = false) {
  await locked(async () => {
    const current = config(), { state, directory } = paths(), health = healthSchema.parse(readJSON(path.join(state, 'status.json')));
    health.last_attempt = Date.now() / 1000;
    try {
      if (await run(['git', 'status', '--porcelain'], current.repo)) throw new Error('Unpublished local edits; commit/push or stash them before refreshing.');
      await run(['git', 'pull', '--ff-only'], current.repo, 15000);
      const data = manifest(current.repo);
      await syncRuntimes(current);
      current.engine = enginePath();
      current.disabled_skills = await engineSelection(current, data);
      current.managed_links = await apply({ repo: current.repo, data, agents: current.targets, previous: current, backup: backupDir('sync-backup'), engine: current.engine, disabled: current.disabled_skills });
      recordCopies(current);
    saveJSON(path.join(directory, 'config.json'), current);
      health.status = 'current'; health.reason = null; health.last_success = Date.now() / 1000;
      await upstreamCheck(current.repo, data, false, true);
    } catch (error) {
      health.status = 'stale'; health.reason = error instanceof Error ? error.message : String(error);
      process.stderr.write('Agent setup refresh failed; cached files retained: ' + health.reason + '\n');
      saveJSON(path.join(state, 'status.json'), health);
      if (!startup) throw error;
    }
    health.revision = await run(['git', 'rev-parse', 'HEAD'], current.repo);
    saveJSON(path.join(state, 'status.json'), health);
  }, startup);
}
export async function reconcileEngine() {
  await locked(async () => {
    const current = config(), data = manifest(current.repo);
    current.disabled_skills = await engineSelection(current, data);
    current.managed_links = await apply({ repo: current.repo, data, agents: current.targets, previous: current, backup: backupDir('native-backup'), engine: enginePath(), disabled: current.disabled_skills });
    recordCopies(current);
    saveJSON(path.join(paths().directory, 'config.json'), current);
  });
}
export async function setSkillSelection(changes: ReadonlyMap<string, boolean>) {
  if (!changes.size) return;
  await locked(async () => {
    const current = config(), data = manifest(current.repo), skills = sourceSkills(current.repo, data);
    for (const name of changes.keys()) if (!skills.has(name) && !current.disabled_skills.includes(name)) throw new Error('Unknown shared skill: ' + name + '. Use agent-backbone skills.');
    const selection = await engineToggle(current, data, changes);
    const managed = await apply({ repo: current.repo, data, agents: current.targets, previous: current, backup: backupDir('toggle-backup'), engine: enginePath(), disabled: selection });
    current.disabled_skills = selection; current.managed_links = managed;
    recordCopies(current);
    saveJSON(path.join(paths().directory, 'config.json'), current);
  });
}
export async function setEnabled(names: string[], enabled: boolean) {
  await setSkillSelection(new Map(names.map(name => [name, enabled])));
  process.stdout.write((enabled ? 'Enabled ' : 'Disabled ') + names.join(', ') + '. Disabled sources keep updating. Start a new agent session to reload skills.\n');
}
export function skills() {
  const current = config(), available = sourceSkills(current.repo, manifest(current.repo));
  const names = new Set([...available.keys(), ...current.disabled_skills]);
  for (const name of [...names].sort()) process.stdout.write((current.disabled_skills.includes(name) ? 'disabled ' : 'enabled  ') + name + (available.has(name) ? '' : ' (removed upstream)') + '\n');
}
export async function status() {
  const current = config(), health = healthSchema.parse(readJSON(path.join(paths().state, 'status.json')));
  process.stdout.write('Agent Backbone ' + VERSION + '\nSource: ' + current.repo + '\nSync: ' + (health.status || 'unknown') + ' | revision ' + (health.revision || 'unknown').slice(0, 12) + '\nLocal edits: ' + (await run(['git', 'status', '--porcelain'], current.repo) ? 'pending' : 'none') + '\nTargets: ' + current.targets.join(', ') + '\nDisabled skills: ' + (current.disabled_skills.join(', ') || 'none') + '\n');
  for (const [name, info] of Object.entries(checksSchema.parse(readJSON(path.join(paths().state, 'upstreams.json'))))) process.stdout.write('Upstream ' + name + ': ' + (info.status || 'unknown') + '\n');
}
export function inventory() {
  const byName: Record<string, { agent: string; path: string; sha256: string; installer_source?: z.infer<typeof installerSchema>['skills'][string] }[]> = {}, visited = new Set<string>(), installed: z.infer<typeof installerSchema>['skills'] = {};
  for (const relative of Object.values(roots)) {
    const root = path.join(paths().home, relative);
    for (const file of [path.join(path.dirname(root), '.skill-lock.json'), path.join(path.dirname(real(root)), '.skill-lock.json')]) if (exists(file)) Object.assign(installed, installerSchema.parse(readJSON(file)).skills);
  }
  for (const [agent, relative] of Object.entries({ ...roots, 'codex-legacy': '.codex/skills' })) {
    const root = path.join(paths().home, relative);
    for (const file of walk(root, true).filter(file => path.basename(file) === 'SKILL.md' && !path.relative(root, file).split(path.sep).some(part => part.startsWith('.')))) {
      if (visited.has(real(file))) continue;
      visited.add(real(file));
      const text = fs.readFileSync(file, 'utf8'), name = /^name:\s*(.*?)\s*$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') || path.basename(path.dirname(file));
      const provenance = installed[path.basename(path.dirname(file))];
      (byName[name] ||= []).push({ agent, path: file, sha256: createHash('sha256').update(text).digest('hex'), ...(provenance ? { installer_source: provenance } : {}) });
    }
  }
  const duplicates = Object.fromEntries(Object.entries(byName).filter(([, values]) => values.length > 1));
  process.stdout.write(JSON.stringify({ skills: byName, duplicates, conflicting_instructions: Object.entries(duplicates).filter(([, values]) => new Set(values.map(value => value.sha256)).size > 1).map(([name]) => name) }, null, 2) + '\n');
}
export async function launch(agent: Agent, args: string[]) {
  const executable = config().agents[agent];
  if (!executable) throw new Error('Agent executable was not registered during configuration.');
  await sync(true);
  execute(executable, args[0] === '--' ? args.slice(1) : args);
}
export function execute(executable: string, args: string[]): never {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  if (!process.execve) throw new Error('Node 22.16 or newer is required for agent launch integration.');
  process.execve(executable, [executable, ...args], env);
  throw new Error('Could not launch executable.');
}
