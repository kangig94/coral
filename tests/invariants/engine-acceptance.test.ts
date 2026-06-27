/*
Acceptance gate for the kb_scann engine recipe (plan §AC-X2).

The plan asserts that introducing a hypothetical `kb_scann` engine that
fills `kb.vector` requires (a) one new file at `src/engines/kb-scann/expansion.ts`,
(b) one new entry in `src/expansion/bundled.ts`. Zero edits anywhere else.

This test does NOT add `kb_scann` to the source tree — it verifies the
existing tree's structural property that makes the recipe possible: only
the manifest registry and the lifecycle wiring point reach into
`src/engines/**`, and no engine-id literal appears in code that should be
engine-blind. Adding `kb_scann` would touch only the two documented files;
any drift that lets a third file see engine identity (relative or
`#src/...` import, or a literal string) would surface here.

Companion to `architecture-boundary.test.ts`'s AC7.1/AC7.2 invariants:
this gate phrases the assertions in terms of the recipe target (the
"could a new engine slot in cleanly?" question) so a regression reads as
"the kb_scann recipe would now break" rather than as a plain boundary
violation.
*/

import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import {
  listProductionSourceFiles,
  parseSourceImportEdges,
  parseSourceSubpathImportEdges,
  toCanonicalSrcPath,
  createProductionFileIndex,
} from '#tests/helpers/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const PRODUCTION_FILE_INDEX = createProductionFileIndex(REPO_ROOT, PRODUCTION_FILE_PATHS);

const ALLOWED_ENGINE_IMPORTERS = new Set<string>([
  'src/expansion/bundled.ts',
  'src/coordinator/kb-child/expansion/lifecycle.ts',
]);

const ENGINE_BLIND_SCOPES = [
  'src/kb/',
  'src/coordinator/',
  'src/cli/expansion/',
  'src/infra/',
  'src/runtime/',
] as const;
const ENGINE_IDS = new Set(['orama', 'needle', 'gemini', 'onnx', 'kb-scann']);
const ENGINE_ID_LITERAL_ALLOWED_FILES = new Set<string>(['src/coordinator/kb-child/expansion/lifecycle.ts']);

function isInEngineBlindScope(canonical: string): boolean {
  return ENGINE_BLIND_SCOPES.some((scope) => canonical.startsWith(scope));
}

describe('engine acceptance — kb_scann gate', () => {
  it('only the manifest registry and the lifecycle wiring point import from src/engines/', () => {
    const violations: string[] = [];

    for (const filePath of PRODUCTION_FILE_PATHS) {
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      if (canonical.startsWith('src/engines/')) {
        continue;
      }
      if (ALLOWED_ENGINE_IMPORTERS.has(canonical)) {
        continue;
      }

      const relativeEdges = parseSourceImportEdges(REPO_ROOT, filePath, PRODUCTION_FILE_INDEX).filter((edge) =>
        edge.target.startsWith('src/engines/'),
      );
      const subpathEdges = parseSourceSubpathImportEdges(REPO_ROOT, filePath).filter((edge) =>
        edge.target.startsWith('src/engines/'),
      );

      for (const edge of [...relativeEdges, ...subpathEdges]) {
        violations.push(`${canonical} -> ${edge.target} (${edge.via} ${edge.specifier})`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('no engine-id string literal appears under engine-blind scopes', () => {
    const violations: string[] = [];

    for (const filePath of PRODUCTION_FILE_PATHS) {
      const canonical = toCanonicalSrcPath(REPO_ROOT, filePath);
      if (!isInEngineBlindScope(canonical)) {
        continue;
      }
      if (ENGINE_ID_LITERAL_ALLOWED_FILES.has(canonical)) {
        continue;
      }

      const sourceText = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      function visit(node: ts.Node): void {
        if (ts.isStringLiteral(node) && ENGINE_IDS.has(node.text)) {
          violations.push(`${canonical}:${node.getStart()}: '${node.text}'`);
        } else if (ts.isNoSubstitutionTemplateLiteral(node) && ENGINE_IDS.has(node.text)) {
          violations.push(`${canonical}:${node.getStart()}: \`${node.text}\``);
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
