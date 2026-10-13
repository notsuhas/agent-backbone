import * as fs from 'node:fs';
import * as path from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { parse } from 'yaml';
import { z } from 'zod';
import { config, manifest, sourceSkills } from './delivery.js';
import { inside, contained } from './files.js';
import { setSkillSelection } from './operations.js';

interface ISkill { id: string; source: string; description: string; enabled: boolean }
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
function catalog(): ISkill[] {
  const current = config(), data = manifest(current.repo), available = sourceSkills(current.repo, data);
  const names = new Set([...available.keys(), ...current.disabled_skills]);
  return [...names].sort().map(id => {
    const dir = available.get(id);
    const pkg = dir ? data.packages.find(pkg => inside(contained(current.repo, pkg.path), dir)) : undefined;
    let description = 'Removed upstream; remembered disabled selection.';
    if (dir) {
      const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
      description = header ? z.object({ description: z.string().default('') }).parse(parse(header)).description : '';
    }
    const repository = pkg?.upstream?.repository.replace(/^https:\/\/github.com\//, '').replace(/\.git$/, '');
    const source = repository ? repository + ' / ' + pkg?.name : 'personal: ' + (pkg?.path || data.skills_dir);
    return { id, source: clean(source), description: clean(description), enabled: !current.disabled_skills.includes(id) };
  });
}
function choose(items: ISkill[]): Promise<Map<string, boolean> | undefined> {
  const input = process.stdin, output = process.stdout;
  const selection = new Map(items.map(item => [item.id, item.enabled]));
  let query = '', cursor = 0, closed = false;
  const visible = () => items.filter(item => (item.id + ' ' + item.source + ' ' + item.description).toLowerCase().includes(query.toLowerCase()));
  const changes = () => new Map(items.filter(item => selection.get(item.id) !== item.enabled).map(item => [item.id, selection.get(item.id) ?? item.enabled]));
  const wasRaw = input.isRaw, wasPaused = input.isPaused();
  const clipped = (text: string) => {
    const width = Math.max(1, (output.columns || 80) - 2);
    return text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text;
  };
  function render() {
    const shown = visible(), height = Math.max(1, (output.rows || 24) - 10);
    cursor = Math.max(0, Math.min(cursor, shown.length - 1));
    const start = Math.max(0, Math.min(cursor - Math.floor(height / 2), shown.length - height));
    const enabled = [...selection.values()].filter(Boolean).length;
    const lines = ['\x1b[1;36m' + clipped('Agent Backbone  /  Skills') + '\x1b[0m', clipped(`${enabled}/${items.length} enabled  ·  ${changes().size} pending changes`), '', '\x1b[36m' + clipped('Search: ' + (query || 'type to filter…')) + '\x1b[0m', ''];
    for (let index = start; index < Math.min(shown.length, start + height); index++) {
      const item = shown[index];
      if (!item) continue;
      const row = clipped(`${index === cursor ? '›' : ' '} [${selection.get(item.id) ? 'x' : ' '}] ${item.id}  —  ${item.source}`);
      lines.push(index === cursor ? '\x1b[7m' + row + '\x1b[0m' : row);
    }
    if (!shown.length) lines.push('\x1b[33mNo matching skills. Backspace or Esc clears the search.\x1b[0m');
    const selected = shown[cursor];
    lines.push('', '\x1b[2m' + clipped(selected?.description || '') + '\x1b[0m', clipped(`${shown.length} matches  ·  arrows move  ·  Space toggles  ·  Enter saves`), clipped('Ctrl-A enables matches  ·  Ctrl-D disables matches  ·  Esc clears search / cancels  ·  Ctrl-C cancels'));
    output.write('\x1b[H\x1b[2J' + lines.join('\r\n'));
  }
  return new Promise((resolve, reject) => {
    function cleanup() {
      if (closed) return;
      closed = true;
      input.removeListener('keypress', onKey);
      input.removeListener('end', onCancel);
      input.removeListener('error', onError);
      output.removeListener('resize', render);
      process.removeListener('SIGINT', onCancel);
      process.removeListener('SIGTERM', onCancel);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
    }
    function finish(result?: Map<string, boolean>) { cleanup(); resolve(result); }
    function onCancel() { finish(); }
    function onError(error: Error) { cleanup(); reject(error); }
    function onKey(text: string, key: Key) {
      const shown = visible();
      if (key.ctrl && key.name === 'c') return finish();
      if (key.name === 'return') return finish(changes());
      if (key.name === 'escape') { if (!query) return finish(); query = ''; cursor = 0; }
      else if (key.name === 'up') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'down') cursor = Math.min(shown.length - 1, cursor + 1);
      else if (key.name === 'pageup') cursor -= Math.max(1, (output.rows || 24) - 10);
      else if (key.name === 'pagedown') cursor += Math.max(1, (output.rows || 24) - 10);
      else if (key.name === 'space') { const item = shown[cursor]; if (item) selection.set(item.id, !selection.get(item.id)); }
      else if (key.ctrl && (key.name === 'a' || key.name === 'd')) for (const item of shown) selection.set(item.id, key.name === 'a');
      else if (key.ctrl && key.name === 'u') { query = ''; cursor = 0; }
      else if (key.name === 'backspace') { query = query.slice(0, -1); cursor = 0; }
      else if (!key.ctrl && !key.meta && text && !/[\u0000-\u001f\u007f-\u009f]/.test(text)) { query += text; cursor = 0; }
      render();
    }
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKey);
    input.on('end', onCancel);
    input.on('error', onError);
    output.on('resize', render);
    process.on('SIGINT', onCancel);
    process.on('SIGTERM', onCancel);
    output.write('\x1b[?1049h\x1b[?25l');
    render();
  });
}
export async function pickSkills() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The skill picker needs an interactive terminal. Use agent-backbone skills --list for text output.');
  const items = catalog();
  if (!items.length) { process.stdout.write('No managed skills. Adopt or add skills to your source repository first.\n'); return; }
  const changes = await choose(items);
  if (!changes) { process.stdout.write('Cancelled; no changes saved.\n'); return; }
  await setSkillSelection(changes);
  process.stdout.write(changes.size ? `Saved ${changes.size} skill changes for all configured agents. Disabled sources keep updating. Start a new agent session to reload skills.\n` : 'No changes to save.\n');
}
