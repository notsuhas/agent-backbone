import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { parseSkillFrontmatter } from './frontmatter.js';
import { exists, readJSON, saveJSON, atomicWrite, paths } from './files.js';
import type { Config } from './model.js';

// One Markdown definition per subagent in subagents/, written to every harness in its own format.
type Subagent = { name: string; description: string; body: string };
const definition = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), description: z.string().min(1) });

function readSubagents(repo: string): Subagent[] {
  const dir = path.join(repo, 'subagents');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter(file => file.endsWith('.md')).sort().map(file => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!match) throw new Error('subagents/' + file + ' needs YAML frontmatter with name and description.');
    const meta = definition.parse(parseSkillFrontmatter(match[1]!));
    if (meta.name + '.md' !== file) throw new Error('subagents/' + file + ' must be named ' + meta.name + '.md.');
    return { ...meta, body: match[2]!.trim() + '\n' };
  });
}

export function validateSubagents(repo: string) { return readSubagents(repo).length; }

const yamlString = (value: string) => JSON.stringify(value);
const markdown = (agent: Subagent, extra: string[] = []) => ['---', 'name: ' + agent.name, 'description: ' + yamlString(agent.description), ...extra, '---', '', agent.body].join('\n');
const tomlString = (value: string) => value.includes("'''") ? JSON.stringify(value) : "'''\n" + value + "'''";

function outputs(current: Config, agent: Subagent): [string, string][] {
  const { home } = paths(), files: [string, string][] = [];
  if (current.targets.includes('claude')) files.push([path.join(home, '.claude/agents', agent.name + '.md'), markdown(agent)]);
  if (current.targets.includes('codex')) files.push([path.join(home, '.codex/agents', agent.name + '.toml'), ['name = ' + JSON.stringify(agent.name), 'description = ' + JSON.stringify(agent.description), 'developer_instructions = ' + tomlString(agent.body), ''].join('\n')]);
  if (current.targets.includes('opencode')) files.push([path.join(home, '.config/opencode/agents', agent.name + '.md'), markdown(agent, ['mode: subagent'])]);
  if (exists(path.join(home, '.cursor'))) files.push([path.join(home, '.cursor/agents', agent.name + '.md'), markdown(agent)]);
  if (exists(path.join(home, '.grok'))) files.push([path.join(home, '.grok/agents', agent.name + '.md'), markdown(agent)]);
  return files;
}

export function applySubagents(current: Config) {
  const ledgerFile = path.join(paths().state, 'subagents-managed.json');
  const owned = new Set(z.array(z.string()).parse(readJSON(ledgerFile, [])));
  const written = new Set<string>();
  for (const agent of readSubagents(current.repo)) {
    for (const [file, text] of outputs(current, agent)) {
      const same = exists(file) && fs.readFileSync(file, 'utf8') === text;
      if (exists(file) && !same && !owned.has(file)) { process.stderr.write('Subagent ' + agent.name + ' not written: ' + file + ' already exists and is not managed by Backbone.\n'); continue; }
      if (!same) { fs.mkdirSync(path.dirname(file), { recursive: true }); atomicWrite(file, text); }
      written.add(file);
    }
  }
  for (const file of owned) if (!written.has(file)) fs.rmSync(file, { force: true });
  saveJSON(ledgerFile, [...written].sort());
}
