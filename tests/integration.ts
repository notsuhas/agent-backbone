import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configSchema, healthSchema, manifestSchema } from '../src/model.js';

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/agent-backbone');
const engine = process.env.AGENT_BACKBONE_SKILLSHARE;
if (!engine) throw new Error('Set AGENT_BACKBONE_SKILLSHARE to a trusted Skillshare binary.');
function write(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function read(file: string) { return fs.readFileSync(file, 'utf8'); }
function json(file: string): unknown { return JSON.parse(read(file)); }
function skill(dir: string, name: string, body = 'Version one') { write(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\ndescription: fixture\n---\n' + body + '\n'); write(path.join(dir, 'support.txt'), 'full skill asset\n'); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backbone-test-')), home = path.join(root, 'home'), repo = path.join(root, 'library'), remote = path.join(root, 'remote.git');
  fs.mkdirSync(home); fs.mkdirSync(repo);
  const env = { ...process.env, HOME: home, AGENT_BACKBONE_COMMAND: cliPath, AGENT_BACKBONE_SKILLSHARE: engine, PATH: path.join(home, '.local/bin') + path.delimiter + process.env.PATH };
  function exec(command: string, args: string[], cwd = root, success = true) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 45000 });
    if (result.error) throw result.error;
    if (success) assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0);
    return result;
  }
  const git = (dir: string, ...args: string[]) => exec('git', args, dir).stdout.trim();
  function commit(dir = repo) { git(dir, 'add', '.'); git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-m', 'test: update fixture'); }
  git(repo, 'init', '-b', 'main');
  skill(path.join(repo, 'skills/example'), 'example');
  write(path.join(repo, 'instructions/global.md'), 'Shared instruction v1\n');
  write(path.join(repo, 'backbone.json'), JSON.stringify({ schema_version: 1, skills_dir: 'skills', instructions: [{ path: 'instructions/global.md', agents: ['claude', 'codex'] }] }));
  commit(); git(root, 'clone', '--bare', repo, remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main');
  for (const agent of ['claude', 'codex']) { const file = path.join(home, '.local/bin', agent); write(file, '#!/bin/sh\nprintf "original ' + agent + ' %s\\n" "$*"\n'); fs.chmodSync(file, 0o755); }
  const cli = (...args: string[]) => exec(cliPath, args);
  const cliFail = (...args: string[]) => exec(cliPath, args, root, false);
  function configure() { cli('configure', repo, '--no-background'); }
  function writer() { const dir = path.join(root, 'writer'); git(root, 'clone', remote, dir); return dir; }
  function push(dir = repo) { commit(dir); git(dir, 'push'); }
  function plugin() {
    const pkg = path.join(repo, 'packages/demo');
    skill(path.join(pkg, 'skills/first'), 'first'); skill(path.join(pkg, 'skills/second'), 'second');
    write(path.join(pkg, 'HOST.md'), 'My adapter must survive\n'); write(path.join(pkg, 'agents/worker.md'), 'Worker prompt\n'); write(path.join(pkg, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
    for (const name of ['first', 'second']) fs.symlinkSync('../packages/demo/skills/' + name, path.join(repo, 'skills', name), 'dir');
    const data = manifestSchema.parse(json(path.join(repo, 'backbone.json')));
    data.packages.push({ name: 'demo', path: 'packages/demo', claude_plugin: true, host_notes: 'HOST.md', local_files: ['HOST.md', '.claude-plugin/plugin.json'] });
    write(path.join(repo, 'backbone.json'), JSON.stringify(data)); push(); return pkg;
  }
  return { root, home, repo, remote, env, git, commit, exec, cli, cliFail, configure, writer, push, plugin, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('preserves shared instruction symlinks, assets, repeated configuration and agent protocol', t => {
  const f = fixture(); t.after(f.cleanup);
  const global = path.join(f.home, 'dotfiles/GLOBAL.md'); write(global, 'Local preferences survive.\n');
  for (const relative of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) { const file = path.join(f.home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(global, file); }
  f.configure();
  for (const relative of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) assert.ok(fs.lstatSync(path.join(f.home, relative)).isSymbolicLink());
  assert.match(read(global), /Local preferences survive/); assert.match(read(global), /Shared instruction v1/);
  assert.equal(read(global).split('<!-- agent-backbone:begin -->').length, 2);
  assert.equal(read(path.join(f.home, '.agents/skills/example/support.txt')), 'full skill asset\n');
  const before = read(global); f.configure(); assert.equal(read(global), before);
  assert.equal(f.exec(path.join(f.home, '.local/bin/codex'), ['app-server', '--stdio']).stdout.trim(), 'original codex app-server --stdio');
});
test('preflights foreign destinations without partial installs', t => {
  const f = fixture(); t.after(f.cleanup);
  const foreign = path.join(f.home, '.agents/skills/example/SKILL.md'); write(foreign, 'Foreign installer content\n');
  assert.match(f.cliFail('configure', f.repo, '--no-background').stderr, /Unmanaged destination/);
  assert.equal(read(foreign), 'Foreign installer content\n'); assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/example')));
});
test('dirty or offline startup retains cached delivery', t => {
  const f = fixture(); t.after(f.cleanup); f.configure();
  write(path.join(f.repo, 'instructions/global.md'), 'Unpublished local edit\n'); f.cli('sync', '--startup');
  const status = healthSchema.parse(json(path.join(f.home, '.local/state/agent-backbone/status.json')));
  assert.equal(status.status, 'stale'); assert.match(status.reason || '', /Unpublished/);
  assert.match(read(path.join(f.home, '.codex/AGENTS.md')), /Shared instruction v1/);
  f.git(f.repo, 'restore', 'instructions/global.md'); f.git(f.repo, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git')); f.cli('sync', '--startup');
  assert.ok(fs.existsSync(path.join(f.home, '.agents/skills/example/SKILL.md')));
});
test('adopts full assets and installer provenance without removing originals', t => {
  const f = fixture(); t.after(f.cleanup); f.configure();
  const external = path.join(f.home, '.cursor/skills/external'); skill(external, 'external');
  write(path.join(f.home, '.cursor/.skill-lock.json'), JSON.stringify({ skills: { external: { source: 'example/vendor', sourceType: 'github', skillPath: 'skills/external/SKILL.md' } } }));
  f.cli('adopt', external, '--name', 'external');
  assert.ok(fs.existsSync(path.join(external, 'support.txt'))); assert.ok(fs.existsSync(path.join(f.repo, 'skills/external/support.txt')));
  const pkg = manifestSchema.parse(json(path.join(f.repo, 'backbone.json'))).packages[0];
  assert.equal(pkg?.upstream?.repository, 'https://github.com/example/vendor.git'); assert.equal(pkg?.upstream?.path, 'skills/external');
  skill(path.join(f.home, '.codex/skills/external'), 'external', 'Different body');
  assert.ok(z.object({ conflicting_instructions: z.array(z.string()) }).parse(JSON.parse(f.cli('inventory').stdout)).conflicting_instructions.includes('external'));
});
test('remote commits refresh instructions and new skills', t => {
  const f = fixture(); t.after(f.cleanup); f.configure(); const writer = f.writer();
  write(path.join(writer, 'instructions/global.md'), 'Shared instruction v2\n'); skill(path.join(writer, 'skills/new-skill'), 'new-skill'); f.push(writer); f.cli('sync');
  for (const relative of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) assert.match(read(path.join(f.home, relative)), /Shared instruction v2/);
  assert.ok(fs.existsSync(path.join(f.home, '.agents/skills/new-skill/SKILL.md')));
});
test('disabled plugin skills stay hidden during updates and reconfigure; enable serves latest', t => {
  const f = fixture(); t.after(f.cleanup); const pkg = f.plugin(); f.configure();
  f.cli('disable', 'first', 'example');
  assert.ok(!fs.existsSync(path.join(f.home, '.agents/skills/first')));
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/example')));
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(f.home, '.agents/packages/demo/skills/first/SKILL.md')));
  assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/second/support.txt')));
  assert.equal(read(path.join(pkg, 'skills/first/SKILL.md')).includes('Version one'), true);
  const writer = f.writer(); skill(path.join(writer, 'packages/demo/skills/first'), 'first', 'Version two'); skill(path.join(writer, 'skills/example'), 'example', 'Version two'); f.push(writer);
  f.cli('sync'); f.configure();
  assert.match(read(path.join(pkg, 'skills/first/SKILL.md')), /Version two/);
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.match(f.cli('skills').stdout, /disabled first/);
  f.cli('enable', 'first', 'example');
  for (const relative of ['.agents/skills/first', '.claude/skills/demo/skills/first', '.claude/skills/example']) assert.match(read(path.join(f.home, relative, 'SKILL.md')), /Version two/);
  assert.deepEqual(configSchema.parse(json(path.join(f.home, '.config/agent-backbone/config.json'))).disabled_skills, []);
});
test('all skills disabled removes plugin alias; toggles are offline and idempotent', t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  f.git(f.repo, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
  f.cli('disable', 'first', 'second'); f.cli('disable', 'first');
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo')));
  assert.ok(!fs.existsSync(path.join(f.home, '.agents/packages/demo')));
  f.cli('enable', 'second'); assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/second/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.match(f.cliFail('disable', 'missing').stderr, /Unknown shared skill/);
});
test('generated package edits are detected and preserved', t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  const asset = path.join(f.home, '.agents/skills/first/support.txt'); write(asset, 'Local edit must not be lost');
  assert.match(f.cliFail('sync').stderr, /Generated skill view was edited/); assert.equal(read(asset), 'Local edit must not be lost');
});
test('upstream updates preserve adapters and disabled selection without agent setup on CI', t => {
  const f = fixture(); t.after(f.cleanup); const pkg = f.plugin();
  const upstream = path.join(f.root, 'upstream'); fs.mkdirSync(upstream); f.git(upstream, 'init', '-b', 'main');
  skill(path.join(upstream, 'plugin/skills/first'), 'first', 'Upstream latest'); skill(path.join(upstream, 'plugin/skills/second'), 'second'); write(path.join(upstream, 'plugin/plugin.json'), JSON.stringify({ version: '2.0.0' })); f.commit(upstream);
  const data = manifestSchema.parse(json(path.join(f.repo, 'backbone.json'))); const demo = data.packages.find(pkg => pkg.name === 'demo'); assert.ok(demo);
  demo.upstream = { repository: upstream, path: 'plugin', ref: 'main' }; write(path.join(f.repo, 'backbone.json'), JSON.stringify(data)); f.push();
  f.configure(); f.cli('disable', 'first');
  f.cli('upstream', 'update', '--all', '--repository', f.repo);
  assert.equal(read(path.join(pkg, 'HOST.md')), 'My adapter must survive\n'); assert.equal(z.object({ version: z.string() }).parse(json(path.join(pkg, '.claude-plugin/plugin.json'))).version, '2.0.0'); assert.match(read(path.join(pkg, 'skills/first/SKILL.md')), /Upstream latest/);
  assert.equal(manifestSchema.parse(json(path.join(f.repo, 'backbone.json'))).packages[0]?.upstream?.approved_tree, f.git(upstream, 'rev-parse', 'HEAD:plugin'));
  f.push(); f.cli('sync'); assert.ok(!fs.existsSync(path.join(f.home, '.agents/skills/first')));
  f.cli('enable', 'first'); assert.match(read(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')), /Upstream latest/);
  const before = f.git(f.repo, 'status', '--porcelain'); f.cli('upstream', 'update', '--all', '--repository', f.repo); assert.equal(f.git(f.repo, 'status', '--porcelain'), before);
});
test('metadata validation fails before CI can publish a broken package', t => {
  const f = fixture(); t.after(f.cleanup); f.cli('validate', '--repository', f.repo);
  write(path.join(f.repo, 'skills/example/SKILL.md'), 'No frontmatter');
  assert.match(f.cliFail('validate', '--repository', f.repo).stderr, /metadata missing/);
});
test('CI updater batches packages without local configuration or Skillshare', t => {
  const f = fixture(); t.after(f.cleanup);
  const data = manifestSchema.parse(json(path.join(f.repo, 'backbone.json')));
  for (const name of ['one', 'two']) {
    const upstream = path.join(f.root, 'upstream-' + name); fs.mkdirSync(upstream); f.git(upstream, 'init', '-b', 'main'); skill(path.join(upstream, 'skills', name), name, 'Latest ' + name); f.commit(upstream);
    const pkg = path.join(f.repo, 'packages', name); skill(pkg, name);
    data.packages.push({ name, path: 'packages/' + name, claude_plugin: false, local_files: [], upstream: { repository: upstream, path: 'skills/' + name, ref: 'main' } });
  }
  write(path.join(f.repo, 'backbone.json'), JSON.stringify(data)); f.push();
  assert.ok(!fs.existsSync(path.join(f.home, '.config/agent-backbone/config.json')));
  f.cli('upstream', 'update', '--all', '--repository', f.repo);
  for (const name of ['one', 'two']) assert.match(read(path.join(f.repo, 'skills', name, 'SKILL.md')), new RegExp('Latest ' + name));
  f.cli('validate', '--repository', f.repo);
  assert.ok(!fs.existsSync(path.join(f.home, '.config/agent-backbone/config.json')));
});

test('agent handoff preserves blocking stdin for delayed protocol input', async t => {
  const f = fixture(); t.after(f.cleanup);
  write(path.join(f.home, '.local/bin/codex'), '#!/bin/sh\nexec /bin/cat\n');
  f.configure();
  const child = spawn(path.join(f.home, '.local/bin/codex'), ['app-server', '--stdio'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { error += data.toString(); });
  const timer = setTimeout(() => child.stdin.end('protocol message\n'), 2000);
  try {
    await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => { if (code === 0) resolve(); else reject(new Error(error)); }); });
    assert.equal(output, 'protocol message\n');
  } finally { clearTimeout(timer); child.kill(); }
});
test('package-relative asset links survive; source links cannot escape the repository', t => {
  const f = fixture(); t.after(f.cleanup); const pkg = f.plugin();
  write(path.join(pkg, 'shared/support.txt'), 'shared package asset');
  fs.symlinkSync('../../shared/support.txt', path.join(pkg, 'skills/first/shared.txt')); f.push(); f.configure();
  f.cli('disable', 'second');
  assert.equal(read(path.join(f.home, '.agents/skills/first/shared.txt')), 'shared package asset');
  const outside = path.join(f.root, 'outside.txt'); write(outside, 'private context');
  fs.symlinkSync(outside, path.join(f.repo, 'skills/example/outside.txt'));
  assert.match(f.cliFail('validate', '--repository', f.repo).stderr, /external link/);
});
