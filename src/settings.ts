import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parse as parseJSON, parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parseTOML } from 'smol-toml';
import { z } from 'zod';
import { exists, isLink, real, readJSON, saveJSON, atomicWrite, paths, run } from './files.js';
import type { Config } from './model.js';

// Writes the keys listed in the content repository's settings/ into each agent's settings file; see README.
type Leaf = { path: string[]; value: unknown };
type Format = 'json' | 'toml';
interface Target { agent: string; source: string; format: Format; file: () => string | undefined; reserved: string[][] }

const object = z.record(z.string(), z.unknown());
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function targets(): Target[] {
  const { home } = paths();
  const firstExisting = (...files: string[]) => files.find(file => exists(file)) || files[files.length - 1];
  const cursorDir = process.platform === 'darwin' ? path.join(home, 'Library/Application Support/Cursor/User') : path.join(home, '.config/Cursor/User');
  return [
    { agent: 'claude', source: 'claude.json', format: 'json', file: () => path.join(home, '.claude/settings.json'), reserved: [['hooks'], ['mcpServers']] },
    { agent: 'codex', source: 'codex.toml', format: 'toml', file: () => path.join(home, '.codex/config.toml'), reserved: [['mcp_servers'], ['hooks'], ['projects']] },
    { agent: 'opencode', source: 'opencode.json', format: 'json', file: () => firstExisting(path.join(home, '.config/opencode/opencode.jsonc'), path.join(home, '.config/opencode/opencode.json')), reserved: [['mcp']] },
    { agent: 'grok', source: 'grok.toml', format: 'toml', file: () => exists(path.join(home, '.grok')) ? path.join(home, '.grok/config.toml') : undefined, reserved: [['hooks'], ['mcp_servers']] },
    { agent: 'cursor', source: 'cursor.json', format: 'json', file: () => exists(cursorDir) ? path.join(cursorDir, 'settings.json') : undefined, reserved: [] },
  ];
}

// Objects are walked into their keys; scalars, arrays and empty objects are leaves.
function leaves(value: unknown, prefix: string[] = []): Leaf[] {
  if (isObject(value) && Object.keys(value).length) return Object.entries(value).flatMap(([key, child]) => leaves(child, [...prefix, key]));
  return [{ path: prefix, value }];
}
const id = (parts: string[]) => JSON.stringify(parts);

function parseJSONC(text: string, label: string): unknown {
  if (!text.trim()) return {};
  const errors: ParseError[] = [], value: unknown = parseJSON(text, errors, { allowTrailingComma: true });
  if (errors[0]) throw new Error(label + ' is not valid JSON: ' + printParseErrorCode(errors[0].error) + ' at offset ' + errors[0].offset);
  return value;
}

// JSON is edited key by key with jsonc-parser so comments and formatting outside the managed keys survive.
const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
function editJSON(text: string, set: Leaf[], remove: string[][], label: string) {
  object.parse(parseJSONC(text, label));
  let result = text;
  const at = (parts: string[]) => { const root = parseTree(result), node = root && findNodeAtLocation(root, parts); return node && { type: node.type, value: getNodeValue(node) as unknown }; };
  const edit = (parts: string[], value: unknown) => { result = applyEdits(result, modify(result, parts, value, formatting)); };
  for (const parts of remove) {
    if (!at(parts)) continue;
    edit(parts, undefined);
    for (let depth = parts.length - 1; depth > 0; depth--) {
      const parent = at(parts.slice(0, depth));
      if (parent?.type !== 'object' || Object.keys(object.parse(parent.value)).length) break;
      edit(parts.slice(0, depth), undefined);
    }
  }
  for (const leaf of set) {
    const current = at(leaf.path);
    if (current && isDeepStrictEqual(current.value, leaf.value)) continue;
    // A non-object on the way to the key is replaced by the nested object.
    const depth = leaf.path.slice(1).findIndex((_, index) => { const node = at(leaf.path.slice(0, index + 1)); return !!node && node.type !== 'object'; }) + 1;
    if (depth > 0) edit(leaf.path.slice(0, depth), leaf.path.slice(depth).reduceRight<unknown>((value, key) => ({ [key]: value }), leaf.value));
    else edit(leaf.path, leaf.value);
  }
  if (!text && result) result += '\n';
  parseJSONC(result, label);
  return result;
}

// TOML is edited line by line so comments, ordering and everything Backbone does not manage stay untouched.
const bare = /^[A-Za-z0-9_-]+$/;
const tomlKey = (key: string) => bare.test(key) ? key : JSON.stringify(key);
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) return '[' + value.map(tomlValue).join(', ') + ']';
  throw new Error('Shared TOML settings support strings, numbers, booleans and arrays of those; use a table for: ' + JSON.stringify(value));
}
const segment = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+`;
// Quoted keys may contain brackets, as in [projects."/p/[w]"].
const header = new RegExp(String.raw`^\s*\[\s*((?:${segment})(?:\s*\.\s*(?:${segment}))*)\s*\]\s*(#.*)?$`);
function headerPath(line: string): string[] | undefined {
  const match = header.exec(line);
  return match ? [...match[1]!.matchAll(new RegExp(segment, 'g'))].map(part => unquote(part[0])) : undefined;
}
const assignment = new RegExp(String.raw`^\s*((?:${segment})(?:\s*\.\s*(?:${segment}))*)\s*=`);
// TOML's own parser decodes a quoted key, so escapes such as \t and \U0001F600 match the real key.
const unquote = (raw: string) => raw.startsWith('"') ? z.string().parse(object.parse(parseTOML('k = ' + raw)).k) : raw.startsWith("'") ? raw.slice(1, -1) : raw;
const startsWith = (list: string[], prefix: string[]) => prefix.length <= list.length && prefix.every((part, index) => list[index] === part);
interface Entry { key: string[]; start: number; end: number }
interface Section { path: string[]; start: number; end: number; entries: Entry[] }

// Returns the line where the value starting at lines[start][offset] ends, following multi-line strings, arrays and inline tables.
function valueEnd(lines: string[], start: number, offset: number) {
  let depth = 0, quote = '';
  for (let line = start; line < lines.length; line++) {
    const text = lines[line]!;
    for (let i = line === start ? offset : 0; i < text.length; i++) {
      if (quote) {
        if (quote[0] === '"' && text[i] === '\\') i++;
        else if (text.startsWith(quote, i)) { i += quote.length - 1; quote = ''; }
        continue;
      }
      const char = text[i]!;
      if (char === '#') break;
      if (text.startsWith('"""', i) || text.startsWith("'''", i)) { quote = text.slice(i, i + 3); i += 2; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
    }
    if (quote.length === 1) quote = '';
    if (!quote && depth <= 0) return line;
  }
  return lines.length - 1;
}
// Lists tables and their keys, skipping the inside of multi-line values so they never look like headers or keys.
function scan(lines: string[]) {
  const sections: Section[] = [{ path: [], start: -1, end: lines.length, entries: [] }];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, header = /^\s*\[\[/.test(line) ? ['\u0000array'] : headerPath(line);
    if (header) { sections[sections.length - 1]!.end = i; sections.push({ path: header, start: i, end: lines.length, entries: [] }); continue; }
    const match = assignment.exec(line);
    if (!match) continue;
    const end = valueEnd(lines, i, match[0].length);
    sections[sections.length - 1]!.entries.push({ key: [...match[1]!.matchAll(new RegExp(segment, 'g'))].map(part => unquote(part[0])), start: i, end });
    i = end;
  }
  return sections;
}
// A key that a dotted key or inline table already defines cannot get its own [table] line.
function refuseOtherForms(sections: Section[], parts: string[]) {
  const table = parts.slice(0, -1);
  for (const section of sections) for (const entry of section.entries) {
    const full = [...section.path, ...entry.key];
    const inline = full.length < parts.length && startsWith(parts, full);
    const dotted = entry.key.length > 1 && (id(full) === id(parts) || entry.key.slice(0, -1).some((_, index) => id([...section.path, ...entry.key.slice(0, index + 1)]) === id(table)));
    if (inline || dotted) throw new Error(parts.join('.') + ' is set with a dotted key or inline table here; move it under a [' + table.map(tomlKey).join('.') + '] header to share it');
  }
}
function editTOML(text: string, set: Leaf[], remove: string[][]) {
  parseTOML(text);
  const lines = text.split('\n');
  const locate = (parts: string[]) => {
    const sections = scan(lines), table = id(parts.slice(0, -1)), key = parts[parts.length - 1]!;
    const section = sections.find(entry => id(entry.path) === table);
    return { sections, section, entry: section?.entries.find(entry => entry.key.length === 1 && entry.key[0] === key) };
  };
  for (const parts of remove) {
    const { section, entry } = locate(parts);
    if (!section || !entry) {
      // Still set in another form: keep it managed and say so, rather than leave it active forever.
      let value: unknown = parseTOML(lines.join('\n'));
      for (const part of parts) value = isObject(value) ? value[part] : undefined;
      if (value !== undefined) throw new Error(parts.join('.') + ' is set with a dotted key or inline table here; move it under a [' + parts.slice(0, -1).map(tomlKey).join('.') + '] header so it can be removed');
      continue;
    }
    const count = entry.end - entry.start + 1, end = section.end - count;
    lines.splice(entry.start, count);
    // Drop the header too once no keys remain.
    if (section.start >= 0 && lines.slice(section.start + 1, end).every(line => !line.trim())) lines.splice(section.start, end - section.start);
  }
  for (const leaf of set) {
    const table = leaf.path.slice(0, -1), text = tomlKey(leaf.path[leaf.path.length - 1]!) + ' = ' + tomlValue(leaf.value);
    const { sections, section, entry } = locate(leaf.path);
    if (entry) { lines.splice(entry.start, entry.end - entry.start + 1, text); continue; }
    refuseOtherForms(sections, leaf.path);
    if (section) {
      let at = section.end; while (at > section.start + 1 && !lines[at - 1]!.trim()) at--;
      lines.splice(at, 0, text);
    } else {
      while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
      lines.push('', '[' + table.map(tomlKey).join('.') + ']', text, '');
    }
  }
  let result = lines.join('\n');
  if (!result.endsWith('\n')) result += '\n';
  parseTOML(result);
  return result;
}

function readDesired(repo: string, target: Target): Leaf[] | undefined {
  const file = path.join(repo, 'settings', target.source);
  if (!exists(file)) return undefined;
  const text = fs.readFileSync(file, 'utf8');
  const document = target.format === 'json' ? object.parse(parseJSONC(text, 'settings/' + target.source)) : object.parse(parseTOML(text));
  const list = leaves(document).filter(leaf => leaf.path.length);
  for (const leaf of list) {
    const blocked = target.reserved.find(prefix => prefix.every((part, index) => leaf.path[index] === part));
    if (blocked) throw new Error('settings/' + target.source + ' may not set ' + blocked.join('.') + '; Backbone or the agent owns it.');
    if (target.format === 'toml') tomlValue(leaf.value);
  }
  return list;
}

export function validateSettings(repo: string) {
  let count = 0;
  for (const target of targets()) { const list = readDesired(repo, target); if (list) count += list.length; }
  return count;
}

export async function applySettings(current: Config) {
  const { state } = paths(), ledgerFile = path.join(state, 'settings-managed.json');
  const ledger = z.record(z.string(), z.array(z.array(z.string()))).parse(readJSON(ledgerFile));
  const next: Record<string, string[][]> = {};
  for (const target of targets()) {
    const file = target.file();
    try {
      const desired = await applyTarget(current, target, file, ledger[target.agent] || []);
      if (!desired) { if (ledger[target.agent]) next[target.agent] = ledger[target.agent]!; }
      else if (desired.length) next[target.agent] = desired;
    } catch (error) {
      process.stderr.write('Shared settings not applied to ' + (file || target.agent) + ': ' + (error instanceof Error ? error.message : String(error)) + '\n');
      if (ledger[target.agent]) next[target.agent] = ledger[target.agent]!;
    }
  }
  saveJSON(ledgerFile, next);
}

// Returns the managed key paths, or undefined when the agent is absent; a removed source removes every key it managed.
async function applyTarget(current: Config, target: Target, file: string | undefined, previous: string[][]) {
  if (!file) return undefined;
  const desired = readDesired(current.repo, target) || [];
  if (!desired.length && !previous.length) return [];
  const wanted = new Set(desired.map(leaf => id(leaf.path)));
  const stale = previous.filter(parts => !wanted.has(id(parts)));
  const destination = isLink(file) ? real(file) : file;
  const text = exists(destination) ? fs.readFileSync(destination, 'utf8') : '';
  const result = target.format === 'json' ? editJSON(text, desired, stale, destination) : editTOML(text, desired, stale);
  if (result !== text && (exists(destination) || desired.length)) atomicWrite(destination, result);
  if (target.agent === 'claude') await installClaudePlugins(current, desired);
  return desired.map(leaf => leaf.path);
}

// Claude plugins listed as enabled in settings/claude.json are installed when missing.
async function installClaudePlugins(current: Config, desired: Leaf[]) {
  const { home } = paths(), claude = current.agents.claude;
  if (!claude || !exists(claude)) return;
  const installed = object.parse(readJSON(path.join(home, '.claude/plugins/installed_plugins.json')));
  const have = new Set(Object.keys(isObject(installed.plugins) ? installed.plugins : installed));
  for (const leaf of desired) {
    if (leaf.path[0] !== 'enabledPlugins' || leaf.path.length !== 2 || leaf.value !== true) continue;
    const plugin = leaf.path[1]!;
    if (have.has(plugin) || plugin.endsWith('@synced')) continue;
    await run([claude, 'plugin', 'install', plugin], undefined, 120000).catch(error => process.stderr.write('Could not install Claude plugin ' + plugin + ': ' + (error instanceof Error ? error.message : String(error)) + '\n'));
  }
}
