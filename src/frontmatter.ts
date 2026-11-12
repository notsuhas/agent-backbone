import { parse } from 'yaml';

// Repair only unquoted text metadata; configuration and structured YAML stay strict.
export function parseSkillFrontmatter(header: string): unknown {
  try { return parse(header); }
  catch {
    const repaired = header.replace(/^(name|description):[ \t]+(.+)$/gm, (line, key: string, value: string) => {
      if (/^["'|>\[{]/.test(value.trimStart()) || !/:\s/.test(value)) return line;
      return key + ': ' + JSON.stringify(value);
    });
    return parse(repaired);
  }
}
