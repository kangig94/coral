/*
Design-philosophy principle 7 / design-rationale §9.5: a module exports only what
it owns. Re-exporting a foreign export outside index.ts creates a second canonical
home for it — future importers then choose between two live paths with no rule to
disambiguate. The only sanctioned shape is a directory's index.ts publishing that
directory's own internal members as the public surface.

Both spellings are the same violation and both are guarded:
- `export { X } from 'A'`
- `import { X } from 'A'; export { X }`

Removed precedents guarded here:
- coordinator/composition/types.ts re-exporting store-services-ref types
- providers/claude/appserver/protocol.ts re-exporting ClaudeBootstrapSignature
- transport/ipc/child-principal-auth.ts and coordinator/child-principal-registry.ts
  re-exporting security/child-principal-env.ts's CORAL_CHILD_PRINCIPAL_HANDLE
- expansion/package-lock.ts re-exporting infra/package-operation-lock.ts constants
- expansion/package-id.ts re-exporting canonical-package-id.ts's validator
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

/**
 * Every module a file republishes an export from, whether through
 * `export ... from 'A'` or through `import { X } from 'A'` followed by a bare
 * `export { X }`. Names the file declares itself are not re-exports.
 */
function reExportSpecifiers(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const importedFrom = new Map<string, string>();
  const specifiers: string[] = [];
  const bareExportNames: string[] = [];

  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          importedFrom.set(element.name.text, node.moduleSpecifier.text);
        }
      }
      return;
    }
    if (!ts.isExportDeclaration(node)) {
      return;
    }
    if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
      return;
    }
    if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        bareExportNames.push((element.propertyName ?? element.name).text);
      }
    }
  });

  for (const name of bareExportNames) {
    const specifier = importedFrom.get(name);
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

describe('no-foreign-re-exports invariant', () => {
  it('should keep production modules free of foreign re-exports outside index.ts', () => {
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
