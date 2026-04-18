import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

import { listProductionSourceFiles, toCanonicalSrcPath } from '../__helpers__/ts-import-scanner.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LEGACY_IDENTIFIER_RE = /^Legacy[A-Za-z0-9_]*$/;
const ALLOWLIST = [
  /^src\/providers\//,
  /^src\/runtime\//,
  /^src\/execution\/kb-tools\.ts$/,
  /^src\/jobs\/shell\/legacy-ingest\.ts$/,
  /^src\/execution\/simulation\/schema\.ts$/,
  /^src\/execution\/simulation\/core\/index\.ts$/,
  /^src\/shared\/legacy-terminal-outcome-compat\.ts$/,
];

function scanForbiddenBoundaryIdentifiers(filePath: string): string[] {
  const sourceText = readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const matches = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node) && (LEGACY_IDENTIFIER_RE.test(node.text) || node.text === 'KbSubsystem')) {
      matches.add(node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...matches].sort();
}

describe('phase-2 boundary quarantine invariant (AC7b)', () => {
  it('keeps Legacy* identifiers and KbSubsystem references inside the allowlist', () => {
    const files = listProductionSourceFiles(join(ROOT, 'src'));
    const violations: string[] = [];

    for (const filePath of files) {
      const canonical = toCanonicalSrcPath(ROOT, filePath);
      const matches = scanForbiddenBoundaryIdentifiers(filePath);
      if (matches.length === 0 || ALLOWLIST.some((pattern) => pattern.test(canonical))) {
        continue;
      }
      violations.push(`${canonical}: ${matches.join(', ')}`);
    }

    expect(violations, 'Legacy* / KbSubsystem references escaped the Phase 2 quarantine boundary').toEqual([]);
  });
});
