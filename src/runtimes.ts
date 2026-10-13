import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { type Config } from './model.js';
import { contained, digest, exists, paths, readJSON, run, saveJSON } from './files.js';

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const policySchema = z.object({ argent: z.object({ version: versionSchema }).optional() }).strict();
const installedSchema = z.object({ version: versionSchema });

function policy(repo: string) {
  return policySchema.parse(readJSON(contained(repo, 'runtimes.json', false)));
}

async function installedArgent() {
  const root = await run(['npm', 'root', '-g']);
  const file = path.join(root, '@swmansion/argent/package.json');
  return exists(file) ? installedSchema.parse(readJSON(file)).version : undefined;
}

async function argentSkillsMatch() {
  const root = await run(['npm', 'root', '-g']);
  const bundled = path.join(root, '@swmansion/argent/skills');
  if (!exists(bundled)) return false;
  const names = fs.readdirSync(bundled).filter(name => exists(path.join(bundled, name, 'SKILL.md')));
  return names.length > 0 && names.every(name => {
    const actual = path.join(paths().home, '.agents/skills', name, 'SKILL.md');
    return exists(actual) && digest(path.dirname(actual)) === digest(path.join(bundled, name));
  });
}

async function preserveArgentPermissions() {
  const file = path.join(paths().home, '.argent/config.json');
  const settings = z.object({ allowlist: z.object({ enabled: z.boolean().optional() }).optional() }).passthrough().parse(readJSON(file));
  if (settings.allowlist?.enabled !== undefined) return;
  const root = await run(['npm', 'root', '-g']);
  await run([process.execPath, path.join(root, '@swmansion/argent/dist/cli.js'), 'config', 'set', 'allowlist.enabled', 'false', '--scope', 'global']);
}

export async function runtimeStatus(repo: string) {
  const desired = policy(repo).argent;
  if (!desired) { process.stdout.write('No managed runtimes configured.\n'); return; }
  process.stdout.write('Argent approved: ' + desired.version + '; installed: ' + (await installedArgent() || 'missing') + '\n');
}

export function pinArgent(repo: string, version: string) {
  const document = policy(repo);
  document.argent = { version: versionSchema.parse(version) };
  saveJSON(contained(repo, 'runtimes.json', false), document);
  process.stdout.write('Argent version recorded locally. Review, commit and merge it to share with other machines.\n');
}

export async function syncRuntimes(current: Config) {
  const desired = policy(current.repo).argent;
  if (!desired) return;
  const stateFile = path.join(paths().state, 'runtimes.json');
  const previous = policySchema.parse(readJSON(stateFile));
  const installed = await installedArgent();
  if (installed && previous.argent?.version === desired.version && installed !== desired.version) {
    throw new Error('Argent changed locally to ' + installed + '. Record the version with agent-backbone runtime pin argent ' + installed + ' before sharing it.');
  }
  const lock = path.join(process.env.XDG_STATE_HOME || path.join(paths().home, '.agents'), process.env.XDG_STATE_HOME ? 'skills/.skill-lock.json' : '.skill-lock.json');
  const skills = z.object({ skills: z.record(z.string(), z.unknown()).default({}) }).parse(readJSON(lock));
  const tracked = Object.keys(skills.skills).some(name => name.startsWith('argent-'));
  if (installed) await preserveArgentPermissions();
  if (installed === desired.version && tracked && previous.argent?.version === desired.version && await argentSkillsMatch()) return;
  const env = { DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1' };
  const cwd = path.join(paths().state, 'runtime-workspace');
  fs.mkdirSync(cwd, { recursive: true });
  await run(['npx', '--yes', '@swmansion/argent@' + desired.version, 'update', '--global', '--version', desired.version, '--yes', '--no-telemetry'], cwd, 240000, env);
  if (!tracked) {
    await run(['npx', '--yes', 'skills', 'add', 'software-mansion/argent/packages/skills/skills#v' + desired.version, '--skill', '*', '--agent', 'claude-code', 'codex', 'opencode', '--global', '--yes'], cwd, 120000, env);
  }
  if (await installedArgent() !== desired.version) throw new Error('Argent installer did not apply the approved version.');
  await preserveArgentPermissions();
  if (!await argentSkillsMatch()) throw new Error('Argent skills did not match the installed CLI.');
  const updated = z.object({ skills: z.record(z.string(), z.unknown()).default({}) }).parse(readJSON(lock));
  if (!Object.keys(updated.skills).some(name => name.startsWith('argent-'))) throw new Error('Argent skills were not registered by its installer.');
  saveJSON(stateFile, { argent: desired });
  process.stdout.write('Argent ' + desired.version + ' applied; its installer owns skill updates.\n');
}
