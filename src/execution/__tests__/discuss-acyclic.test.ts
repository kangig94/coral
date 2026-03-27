import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DISCUSS_DIR = join(__dirname, '..');
const DISCUSS_PREFIX = 'discuss-';

function parseLocalDiscussImports(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf-8');
  const imports: string[] = [];
  for (const match of source.matchAll(/from\s+['"]\.\/(discuss-[^'"]+)['"]/g)) {
    imports.push(match[1]!.replace(/\.js$/, ''));
  }
  return imports;
}

function findSCC(graph: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  function strongconnect(v: string): void {
    const idx = counter++;
    index.set(v, idx);
    lowlink.set(v, idx);
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const v of graph.keys()) {
    if (!index.has(v)) strongconnect(v);
  }
  return sccs;
}

describe('discuss module acyclic import graph', () => {
  it('has no circular import cycles among discuss-*.ts modules', () => {
    const files = readdirSync(DISCUSS_DIR)
      .filter((f) => f.startsWith(DISCUSS_PREFIX) && f.endsWith('.ts') && !f.endsWith('.test.ts'));

    const graph = new Map<string, string[]>();
    for (const file of files) {
      const mod = file.replace(/\.ts$/, '');
      const imports = parseLocalDiscussImports(join(DISCUSS_DIR, file));
      graph.set(mod, imports);
    }

    const sccs = findSCC(graph).filter((scc) => scc.length > 1);
    if (sccs.length > 0) {
      const description = sccs
        .map((scc) => scc.sort().join(' ↔ '))
        .join('\n');
      expect.fail(`Circular import cycle(s) detected:\n${description}`);
    }
  });
});
