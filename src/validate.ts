import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { manifest, sourceSkills } from './delivery.js';

export function validate(repo: string) {
  const data = manifest(repo), skills = sourceSkills(repo, data), names = new Set<string>();
  for (const [id, dir] of skills) {
    const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
    if (!header) throw new Error('Skill metadata missing: ' + id);
    const metadata = z.object({ name: z.string().min(1), description: z.string().min(1) }).parse(parse(header));
    if (names.has(metadata.name)) throw new Error('Duplicate skill metadata name: ' + metadata.name);
    names.add(metadata.name);
  }
  process.stdout.write('Validated ' + skills.size + ' skills and ' + data.packages.length + ' packages.\n');
}
