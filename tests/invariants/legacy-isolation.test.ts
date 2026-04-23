import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const LEGACY_IMPORT = /from\s+['"][^'"]*\/_legacy\/[^'"]*['"]/;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '_legacy' || e.name === '__tests__' || e.name === 'node_modules') continue;
      await walk(full, out);
    } else if (e.isFile() && e.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('legacy-isolation invariant', () => {
  it('no production file imports from _legacy/', async () => {
    const srcDir = join(ROOT, 'src');
    const files = await walk(srcDir);
    const offenders: { file: string; line: number; match: string }[] = [];
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const m = line.match(LEGACY_IMPORT);
        if (m) offenders.push({ file: relative(ROOT, file), line: idx + 1, match: m[0] });
      });
    }
    expect(offenders).toEqual([]);
  });
});
