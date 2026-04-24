import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const ALLOW = new Set(['src/runtime/flavor.ts']);

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'fixtures' || e.name === 'node_modules') continue;
      await walk(full, out);
    } else if (e.isFile() && e.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no-ambient-flavor-reads invariant', () => {
  it('only src/runtime/flavor.ts reads CORAL_FLAVOR', async () => {
    const srcDir = join(ROOT, 'src');
    const files = await walk(srcDir);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (ALLOW.has(rel)) continue;
      const content = await fs.readFile(file, 'utf8');
      if (content.includes('CORAL_FLAVOR')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
