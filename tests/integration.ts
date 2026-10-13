import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseYAML } from 'yaml';
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
async function terminal(f: ReturnType<typeof fixture>, keys: string) {
  const socket = path.join(f.root, 'tmux.sock');
  const tmux = (...args: string[]) => f.exec('tmux', ['-S', socket, ...args]).stdout;
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  tmux('new-session', '-d', '-s', 'picker', '-x', '100', '-y', '24', '/bin/sh');
  try {
    tmux('set-option', '-t', 'picker', 'remain-on-exit', 'on');
    tmux('send-keys', '-t', 'picker', 'exec ' + quote(cliPath) + ' manage', 'Enter');
    async function waitFor(pattern: RegExp) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const screen = tmux('capture-pane', '-p', '-t', 'picker');
        if (pattern.test(screen)) return screen;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Picker terminal timed out: ' + tmux('capture-pane', '-p', '-t', 'picker'));
    }
    const initial = await waitFor(/Search:/);
    for (const key of keys) {
      if (key === '\r') tmux('send-keys', '-t', 'picker', 'Enter');
      else if (key === '\u0003') tmux('send-keys', '-t', 'picker', 'C-c');
      else if (key === '\u0004') tmux('send-keys', '-t', 'picker', 'C-d');
      else tmux('send-keys', '-t', 'picker', '-l', key);
    }
    const result = await waitFor(/Saved \d+ skill changes|Cancelled; no changes saved|No changes to save/);
    return initial + '\n' + result;
  } finally { tmux('kill-server'); }
}
test('PTY picker saves a filtered toggle and hides it in both native agents', async t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  const output = await terminal(f, 'first \r');
  assert.match(output, /personal: packages\/demo/); assert.match(output, /Saved 1 skill changes/);
  assert.deepEqual(configSchema.parse(json(path.join(f.home, '.config/agent-backbone/config.json'))).disabled_skills, ['first']);
  assert.ok(!fs.existsSync(path.join(f.home, '.agents/skills/first')));
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/second/SKILL.md')));
  const enabled = await terminal(f, 'first \r'); assert.match(enabled, /Saved 1 skill changes/);
  assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
});
test('PTY picker cancels pending changes and bulk toggles only filtered matches', async t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  const file = path.join(f.home, '.config/agent-backbone/config.json'), before = read(file);
  assert.match(await terminal(f, 'first \u0003'), /Cancelled; no changes saved/); assert.equal(read(file), before);
  assert.match(await terminal(f, 'packages/demo\u0004\r'), /Saved 2 skill changes/);
  assert.deepEqual(configSchema.parse(parseYAML(read(file))).disabled_skills, ['first', 'second']);
  assert.ok(fs.existsSync(path.join(f.home, '.agents/skills/example/SKILL.md')));
});
test('forced picker rejects non-TTY input; explicit list works without writes', t => {
  const f = fixture(); t.after(f.cleanup); f.configure();
  const file = path.join(f.home, '.config/agent-backbone/config.json'), before = read(file);
  assert.match(f.cliFail('manage').stderr, /interactive terminal/);
  assert.match(f.cliFail('skills', '--interactive').stderr, /interactive terminal/);
  assert.match(f.cli('skills', '--list').stdout, /enabled  example/);
  assert.equal(read(file), before);
});
test('native Skillshare toggles share state with the picker and survive refresh', t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  f.cli('skillshare', 'disable', 'first', '--global');
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/second')));
  assert.match(f.cli('skillshare', 'list', '--json', '--global').stdout, /"disabled": true/);
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
  f.cli('sync'); f.configure();
  assert.ok(!fs.existsSync(path.join(f.home, '.agents/skills/first')));
  f.cli('enable', 'first');
  assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.ok(!f.cli('skillshare', 'list', '--json', '--global').stdout.includes('"disabled": true'));
});
test('native MCP definitions persist across refresh and preserve foreign servers and credentials', t => {
  const f = fixture(); t.after(f.cleanup); f.configure();
  write(path.join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { foreign: { type: 'http', url: 'https://foreign.invalid/mcp' } } }));
  write(path.join(f.home, '.codex/config.toml'), '[mcp_servers.foreign]\nurl = "https://foreign.invalid/mcp"\n');
  const auth = path.join(f.home, '.codex/auth.json'); write(auth, '{"fixture":"credential remains local"}');
  f.cli('mcp', 'add', 'shared', '--url', 'https://docs.invalid/mcp', '--target', 'claude', '--target', 'codex', '--no-tui');
  f.cli('sync'); f.configure();
  const claude = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).parse(json(path.join(f.home, '.claude.json')));
  assert.ok(claude.mcpServers.shared); assert.ok(claude.mcpServers.foreign);
  assert.match(read(path.join(f.home, '.codex/config.toml')), /mcp_servers.shared/);
  assert.match(read(path.join(f.home, '.codex/config.toml')), /mcp_servers.foreign/);
  assert.equal(read(auth), '{"fixture":"credential remains local"}');
  assert.ok(fs.statSync(path.join(f.home, '.config/agent-backbone/skillshare-control.yaml')).mode & 0o600);
});
test('native target settings persist and turning off Claude removes its full plugin', t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  const file = path.join(f.home, '.config/agent-backbone/skillshare-control.yaml');
  const document = z.record(z.string(), z.unknown()).parse(parseYAML(read(file)));
  const targets = z.record(z.string(), z.unknown()).parse(document.targets);
  const claude = z.record(z.string(), z.unknown()).parse(targets.claude);
  claude.skills = { enabled: false }; targets.claude = claude; document.targets = targets;
  document.tui = false; write(file, JSON.stringify(document)); f.cli('sync');
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo')));
  assert.ok(fs.existsSync(path.join(f.home, '.agents/skills/first/SKILL.md')));
  f.configure(); assert.equal(z.record(z.string(), z.unknown()).parse(parseYAML(read(file))).tui, false);
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo')));
});
test('Git MCP definitions refresh into native configs without copying local credentials', t => {
  const f = fixture(); t.after(f.cleanup);
  write(path.join(f.repo, 'mcp.yaml'), 'servers: {}\n'); f.push(); f.configure();
  const writer = f.writer();
  write(path.join(writer, 'mcp.yaml'), 'servers:\n  shared:\n    url: https://docs.invalid/mcp\n    targets: [claude, codex]\n');
  f.push(writer); f.cli('sync');
  const native = z.object({ mcpServers: z.record(z.string(), z.unknown()) }).parse(json(path.join(f.home, '.claude.json')));
  assert.ok(native.mcpServers.shared);
  assert.match(read(path.join(f.home, '.codex/config.toml')), /mcp_servers.shared/);
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
});
test('custom agents use native Skillshare sync with per-target paths', t => {
  const f = fixture(); t.after(f.cleanup);
  write(path.join(f.repo, 'agents/worker.md'), '---\nname: worker\ndescription: fixture agent\n---\nDo the assigned task.\n'); f.push(); f.configure();
  const file = path.join(f.home, '.config/agent-backbone/skillshare-control.yaml');
  const doc = z.record(z.string(), z.unknown()).parse(parseYAML(read(file))), targets = z.record(z.string(), z.unknown()).parse(doc.targets);
  targets.claude = { ...z.record(z.string(), z.unknown()).parse(targets.claude), agents: { path: path.join(f.home, '.claude/agents'), mode: 'merge' } };
  doc.targets = targets; write(file, JSON.stringify(doc)); f.cli('sync');
  assert.match(read(path.join(f.home, '.claude/agents/worker.md')), /assigned task/);
  assert.match(f.cli('agents', '--json', '--global').stdout, /worker/);
});
test('native copy mode persists, detects local edits and removes disabled copies', t => {
  const f = fixture(); t.after(f.cleanup); f.configure();
  const file = path.join(f.home, '.config/agent-backbone/skillshare-control.yaml');
  const doc = z.record(z.string(), z.unknown()).parse(parseYAML(read(file))), targets = z.record(z.string(), z.unknown()).parse(doc.targets);
  targets.codex = { skills: { path: path.join(f.home, '.agents/skills'), mode: 'copy' } }; doc.targets = targets; write(file, JSON.stringify(doc));
  f.cli('sync'); assert.ok(!fs.lstatSync(path.join(f.home, '.agents/skills/example')).isSymbolicLink());
  f.cli('sync'); f.cli('disable', 'example'); assert.ok(!fs.existsSync(path.join(f.home, '.agents/skills/example')));
  f.cli('enable', 'example');
  const asset = path.join(f.home, '.agents/skills/example/support.txt'); write(asset, 'Unpublished target edit');
  assert.match(f.cliFail('sync').stderr, /Unmanaged destination|edited/); assert.equal(read(asset), 'Unpublished target edit');
});
test('native ignore overrides do not let the checkbox picker falsely claim a toggle', t => {
  const f = fixture(); t.after(f.cleanup); f.configure();
  write(path.join(f.repo, 'skills/.skillignore.local'), '!example\n');
  assert.match(f.cliFail('disable', 'example').stderr, /ignore rule overrides/);
  assert.ok(fs.existsSync(path.join(f.home, '.agents/skills/example/SKILL.md')));
  assert.equal(read(path.join(f.repo, 'skills/.skillignore')), '');
  assert.equal(f.git(f.repo, 'status', '--porcelain'), '');
});

test('native dashboard edits canonical files and applies disable/enable to full plugins', async t => {
  const f = fixture(); t.after(f.cleanup); const pkg = f.plugin(); f.configure();
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const child = spawn(cliPath, ['ui', '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = ''; child.stdout.on('data', (data: Buffer) => { diagnostics += data.toString(); }); child.stderr.on('data', (data: Buffer) => { diagnostics += data.toString(); });
  const base = 'http://127.0.0.1:' + port;
  async function waitFor(check: () => Promise<boolean> | boolean) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await check()) return; if (child.exitCode !== null) throw new Error(diagnostics); await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Dashboard timed out: ' + diagnostics);
  }
  async function request(endpoint: string, method = 'GET', body?: string) {
    const response = await fetch(base + endpoint, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body } : {}), signal: AbortSignal.timeout(3000) });
    assert.ok(response.ok, await response.text());
  }
  try {
    await waitFor(async () => { try { return (await fetch(base + '/api/resources', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } });
    const diff = z.object({ diffs: z.array(z.object({ items: z.array(z.unknown()) })) }).parse(await (await fetch(base + '/api/diff')).json());
    assert.ok(diff.diffs.every(target => target.items.length === 0), 'Dashboard reported generated delivery links as stale.');
    const targets = z.object({ targets: z.array(z.object({ linkedCount: z.number(), expectedSkillCount: z.number() })) }).parse(await (await fetch(base + '/api/targets')).json());
    assert.ok(targets.targets.every(target => target.linkedCount === target.expectedSkillCount), 'Dashboard summary did not recognize plugin delivery.');
    const forbidden = await fetch(base + '/api/resources/first/disable', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403);
    await request('/api/resources/first/disable', 'POST', '{}');
    await waitFor(() => !fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
    assert.ok(!fs.existsSync(path.join(f.home, '.agents/skills/first')));
    assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/second')));
    await request('/api/resources/first/enable', 'POST', '{}');
    await waitFor(() => fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
    const updatedBody = read(path.join(pkg, 'skills/first/SKILL.md')).replace('Version one', 'Edited from native dashboard');
    await request('/api/resources/first/content', 'PUT', JSON.stringify({ content: updatedBody }));
    assert.match(read(path.join(pkg, 'skills/first/SKILL.md')), /Edited from native dashboard/);
    write(path.join(pkg, 'skills/first/support.txt'), 'Edited canonical asset');
    await waitFor(() => read(path.join(f.home, '.agents/skills/first/support.txt')) === 'Edited canonical asset');
    assert.match(f.git(f.repo, 'status', '--porcelain'), /support.txt/);
    assert.ok(!/Generated skill view was edited/.test(diagnostics));
  } finally {
    child.kill('SIGINT');
    await new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else { const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('close', () => { clearTimeout(timeout); resolve(); }); } });
  }
});
test('per-agent native filters also remove skills from full Claude plugins', t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  const file = path.join(f.home, '.config/agent-backbone/skillshare-control.yaml');
  const doc = z.record(z.string(), z.unknown()).parse(parseYAML(read(file))), targets = z.record(z.string(), z.unknown()).parse(doc.targets);
  targets.claude = { skills: { path: path.join(f.home, '.claude/skills'), exclude: ['first'] } }; doc.targets = targets;
  write(file, JSON.stringify(doc)); f.cli('sync');
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/second/SKILL.md')));
  assert.ok(fs.existsSync(path.join(f.home, '.agents/skills/first/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(f.home, '.claude/skills/first')));
  assert.match(read(path.join(f.home, '.claude/CLAUDE.md')), /Disabled skills: first/);
});
test('native hooks and extras persist without executing hooks or losing startup refresh', t => {
  const f = fixture(); t.after(f.cleanup); f.configure();
  const marker = path.join(f.home, 'hook-executed'), entry = path.join(f.root, 'hook.json');
  write(entry, JSON.stringify({ bindings: { claude: { events: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'touch "' + marker + '"' }] }] } } } }));
  f.cli('hooks', 'add', 'fixture', '--file', entry, '--global');
  const rule = path.join(f.repo, 'extras/rules/rule.md'); write(rule, 'Shared fixture rule\n'); f.push();
  const file = path.join(f.home, '.config/agent-backbone/skillshare-control.yaml');
  const doc = z.record(z.string(), z.unknown()).parse(parseYAML(read(file)));
  doc.extras = [{ name: 'rules', source: path.join(f.repo, 'extras/rules'), targets: [{ path: path.join(f.home, '.claude/rules'), mode: 'merge' }] }];
  write(file, JSON.stringify(doc)); f.cli('sync'); f.configure();
  assert.equal(read(path.join(f.home, '.claude/rules/rule.md')), 'Shared fixture rule\n');
  assert.match(read(path.join(f.home, '.claude/settings.json')), /hook-executed/);
  assert.match(read(path.join(f.home, '.claude/settings.json')), /agent-backbone-refresh/);
  assert.ok(!fs.existsSync(marker));
  assert.match(f.cli('hooks', 'list', '--json', '--global').stdout, /fixture/);
});

test('migration removes generated plugin exclusions in modern Skillshare target syntax', t => {
  const f = fixture(); t.after(f.cleanup); f.plugin(); f.configure();
  const control = path.join(f.home, '.config/agent-backbone/skillshare-control.yaml');
  fs.unlinkSync(control);
  const delivery = path.join(f.home, '.config/agent-backbone/skillshare.yaml');
  const document = z.record(z.string(), z.unknown()).parse(parseYAML(read(delivery)));
  const targets = z.record(z.string(), z.unknown()).parse(document.targets);
  const claude = z.record(z.string(), z.unknown()).parse(targets.claude);
  const settings = z.record(z.string(), z.unknown()).parse(claude.skills);
  settings.exclude = ['first', 'second']; claude.skills = settings; targets.claude = claude; document.targets = targets;
  write(delivery, JSON.stringify(document)); f.cli('sync');
  assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/first/SKILL.md')));
  assert.ok(fs.existsSync(path.join(f.home, '.claude/skills/demo/skills/second/SKILL.md')));
});
