import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { listProductionSourceFiles, parseProductionImportEdges } from '#tests/helpers/ts-import-scanner.js';

// `parseProductionImportEdges` is the single edge source every import-graph
// invariant builds on. Production code reaches another src/ file two ways —
// a relative path (`../two/b.js`) or the project's `#src/*` subpath alias
// (`#src/two/b.js`) — and a consumer that only sees one spelling silently
// walks a partial graph. This fixture writes the same target import in both
// spellings from two different sources and proves the scanner reports both,
// so a layering or acyclicity check built on its output cannot be blind to
// either style.
const repoRoot = mkdtempSync(join(tmpdir(), 'coral-ts-import-scanner-'));

mkdirSync(join(repoRoot, 'src', 'one'), { recursive: true });
mkdirSync(join(repoRoot, 'src', 'two'), { recursive: true });
mkdirSync(join(repoRoot, 'src', 'three'), { recursive: true });
writeFileSync(join(repoRoot, 'src', 'two', 'b.ts'), "export const marker = 'b';\n");
writeFileSync(join(repoRoot, 'src', 'one', 'a.ts'), "import '../two/b.js';\nexport const marker = 'a';\n");
writeFileSync(join(repoRoot, 'src', 'three', 'c.ts'), "import '#src/two/b.js';\nexport const marker = 'c';\n");

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('ts-import-scanner subpath completeness', () => {
  it('parses a #src/ subpath edge with the same completeness as a relative-path edge', () => {
    const files = listProductionSourceFiles(join(repoRoot, 'src'));
    const edges = parseProductionImportEdges(repoRoot, files);

    expect(edges).toContainEqual(
      expect.objectContaining({
        source: 'src/one/a.ts',
        target: 'src/two/b.ts',
        specifier: '../two/b.js',
        via: 'ImportDeclaration',
      }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({
        source: 'src/three/c.ts',
        target: 'src/two/b.ts',
        specifier: '#src/two/b.js',
        via: 'ImportDeclaration',
      }),
    );
  });

  it('lets a layering check built on these edges catch a forbidden import in either spelling', () => {
    // Mirrors the `collectViolations` shape every real layering invariant
    // uses: filter edges whose source/target cross a forbidden boundary.
    const files = listProductionSourceFiles(join(repoRoot, 'src'));
    const edges = parseProductionImportEdges(repoRoot, files);
    const forbiddenImportsOf = (sourceRoot: string) =>
      edges
        .filter((edge) => edge.source.startsWith(sourceRoot) && edge.target.startsWith('src/two/'))
        .map((edge) => `${edge.source} -> ${edge.target} (${edge.specifier})`);

    expect(forbiddenImportsOf('src/one/')).toEqual(['src/one/a.ts -> src/two/b.ts (../two/b.js)']);
    expect(forbiddenImportsOf('src/three/')).toEqual(['src/three/c.ts -> src/two/b.ts (#src/two/b.js)']);
  });
});
