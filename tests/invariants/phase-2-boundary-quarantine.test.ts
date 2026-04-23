import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LEGACY_IDENTIFIER_RE = /^Legacy[A-Za-z0-9_]*$/;
const LEGACY_HELPERS = new Set([
  'describeLegacyCoralFault',
  'legacyWrapperCrashedFault',
  'materializeLegacyTerminalOutcome',
  'planLegacyTerminalOutcome',
  'Recovery' + 'FaultCompat',
]);

function scanForbiddenBoundaryIdentifiers(filePath: string): string[] {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isIdentifier(node)
      && (LEGACY_IDENTIFIER_RE.test(node.text) || LEGACY_HELPERS.has(node.text) || node.text === 'KbSubsystem')
    ) {
      matches.add(node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...matches].sort();
}

describe('phase-2 boundary quarantine invariant (AC3.7)', () => {
  it('keeps production src canonical-only across the former legacy compat boundary', () => {
    const files = listProductionSourceFiles(join(ROOT, 'src'));
    const violations: string[] = [];

    for (const filePath of files) {
      const canonical = toCanonicalSrcPath(ROOT, filePath);
      const matches = scanForbiddenBoundaryIdentifiers(filePath);
      if (matches.length === 0) {
        continue;
      }
      violations.push(`${canonical}: ${matches.join(', ')}`);
    }

    expect(violations, 'Legacy* / KbSubsystem references escaped the canonical-only runtime boundary').toEqual([]);
  });
});
