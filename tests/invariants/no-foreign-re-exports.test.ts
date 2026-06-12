/*
Design-philosophy principle 7 / design-rationale §9.5: a module exports only what
it owns. `export ... from` outside index.ts creates a second canonical home for a
foreign export — future importers then choose between two live paths with no rule
to disambiguate. The only sanctioned shape is a directory's index.ts publishing
that directory's own internal members as the public surface.

Removed precedents guarded here:
- coordinator/composition/types.ts re-exporting store-services-ref types
- providers/claude/appserver/protocol.ts re-exporting ClaudeBootstrapSignature
*/
import { basename, dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');

function reExportSpecifiers(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  source.forEachChild((node) => {
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

describe('no-foreign-re-exports invariant', () => {
  it('should keep production modules free of export-from outside index.ts', () => {
    const offenders: string[] = [];
    for (const filePath of listProductionSourceFiles(SRC_ROOT)) {
      if (basename(filePath) === 'index.ts') continue;
      for (const specifier of reExportSpecifiers(filePath)) {
        offenders.push(`${filePath.slice(REPO_ROOT.length + 1)} re-exports from '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('should keep index.ts re-exports inside their own directory', () => {
    const offenders: string[] = [];
    for (const filePath of listProductionSourceFiles(SRC_ROOT)) {
      if (basename(filePath) !== 'index.ts') continue;
      for (const specifier of reExportSpecifiers(filePath)) {
        if (!specifier.startsWith('./')) {
          offenders.push(`${filePath.slice(REPO_ROOT.length + 1)} re-exports foreign module '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
