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
    { agent: 'grok', source: 'grok.toml', format: 'toml', file: () => exists(path.join(home, '.grok')) ? path.join(home, '.grok/config.toml') : undefined, reserved: [['hooks']] },
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
function headerPath(line: string): string[] | undefined {
  const match = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
  if (!match) return undefined;
  const parts: string[] = [], text = match[1]!.trim();
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') { let j = i + 1, value = ''; while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; value += text[j]; j++; } parts.push(value); i = j + 1; }
    else if (text[i] === "'") { const j = text.indexOf("'", i + 1); parts.push(text.slice(i + 1, j)); i = j + 1; }
    else { let j = i; while (j < text.length && !/[.\s]/.test(text[j]!)) j++; parts.push(text.slice(i, j)); i = j; }
    while (i < text.length && /[\s.]/.test(text[i]!)) i++;
  }
  return parts;
}
function keyLine(line: string, key: string) {
  const match = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/.exec(line);
  if (!match) return false;
  const raw = match[1]!;
  return (raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw) === key;
}
function editTOML(text: string, set: Leaf[], remove: string[][]) {
  const lines = text.split('\n');
  const sections = () => {
    const found: { path: string[]; start: number; end: number }[] = [{ path: [], start: -1, end: lines.length }];
    lines.forEach((line, index) => { if (/^\s*\[\[/.test(line)) { found[found.length - 1]!.end = index; found.push({ path: ['\u0000array'], start: index, end: lines.length }); return; }
      const parts = headerPath(line); if (parts) { found[found.length - 1]!.end = index; found.push({ path: parts, start: index, end: lines.length }); } });
    return found;
  };
  const locate = (table: string[], key: string) => {
    const section = sections().find(entry => id(entry.path) === id(table));
    if (!section) return { section: undefined, line: -1 };
    for (let i = section.start + 1; i < section.end; i++) if (keyLine(lines[i]!, key)) return { section, line: i };
    return { section, line: -1 };
  };
  for (const parts of remove) {
    const { section, line } = locate(parts.slice(0, -1), parts[parts.length - 1]!);
    if (line < 0 || !section) continue;
    lines.splice(line, 1);
    // The section now ends one line earlier. Drop its header too once no keys remain.
    const end = section.end - 1;
    if (section.start >= 0 && lines.slice(section.start + 1, end).every(text => !text.trim())) lines.splice(section.start, end - section.start);
  }
  for (const leaf of set) {
    const table = leaf.path.slice(0, -1), key = leaf.path[leaf.path.length - 1]!;
    const text = tomlKey(key) + ' = ' + tomlValue(leaf.value);
    const { section, line } = locate(table, key);
    if (line >= 0) { if (/("""|''')/.test(lines[line]!)) throw new Error('Multi-line TOML values cannot be shared: ' + leaf.path.join('.')); lines[line] = text; continue; }
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
      if (desired) next[target.agent] = desired;
      else if (ledger[target.agent]) next[target.agent] = ledger[target.agent]!;
    } catch (error) {
      process.stderr.write('Shared settings not applied to ' + (file || target.agent) + ': ' + (error instanceof Error ? error.message : String(error)) + '\n');
      if (ledger[target.agent]) next[target.agent] = ledger[target.agent]!;
    }
  }
  saveJSON(ledgerFile, next);
}

// Returns the managed key paths, or undefined when the target has nothing to manage.
async function applyTarget(current: Config, target: Target, file: string | undefined, previous: string[][]) {
  const desired = readDesired(current.repo, target);
  if (!desired || !file) return undefined;
  const wanted = new Set(desired.map(leaf => id(leaf.path)));
  const stale = previous.filter(parts => !wanted.has(id(parts)));
  const destination = isLink(file) ? real(file) : file;
  const text = exists(destination) ? fs.readFileSync(destination, 'utf8') : '';
  const result = target.format === 'json' ? editJSON(text, desired, stale, destination) : editTOML(text, desired, stale);
  if (result !== text) atomicWrite(destination, result);
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
