import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillFrontmatter } from '../src/frontmatter.js';

test('repairs upstream text metadata while retaining YAML types and quoted values', () => {
  assert.deepEqual(parseSkillFrontmatter('name: factory\ndescription: Software factory: tasks\ndisable-model-invocation: true\n'), { name: 'factory', description: 'Software factory: tasks', 'disable-model-invocation': true });
  assert.deepEqual(parseSkillFrontmatter('name: factory\ndescription: "Already: quoted"\npaths: ["**/*.ts"]\n'), { name: 'factory', description: 'Already: quoted', paths: ['**/*.ts'] });
  assert.deepEqual(parseSkillFrontmatter('name: factory\ndescription: |\n  One: two\n'), { name: 'factory', description: 'One: two\n' });
});

test('does not hide malformed structured YAML or duplicate metadata keys', () => {
  for (const header of ['name: one\nname: two', 'description: [broken', 'description: Text: value\nsettings: [broken', 'description: Text: value\nsettings: value: nested']) assert.throws(() => parseSkillFrontmatter(header));
});
