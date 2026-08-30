import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RETIRED_PUBLICATION_NAME = 'publishHandoffRoutingTransitions';

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false;
}

function retiredPublicationEdges(filePath: string): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const edges: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.name?.text === RETIRED_PUBLICATION_NAME) edges.push('import');
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (
            element.name.text === RETIRED_PUBLICATION_NAME ||
            element.propertyName?.text === RETIRED_PUBLICATION_NAME
          ) {
            edges.push('import');
          }
        }
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === RETIRED_PUBLICATION_NAME || element.propertyName?.text === RETIRED_PUBLICATION_NAME) {
          edges.push('export');
        }
      }
      continue;
    }
    if (
      hasExportModifier(statement) &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name?.text === RETIRED_PUBLICATION_NAME
    ) {
      edges.push('export');
      continue;
    }
    if (hasExportModifier(statement) && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === RETIRED_PUBLICATION_NAME) {
          edges.push('export');
        }
      }
      continue;
    }
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === RETIRED_PUBLICATION_NAME
    ) {
      edges.push('export');
    }
  }
  return edges;
}

describe('handoff routing publication lease invariant', () => {
  it('rejects every import or export of the retired unleased publication surface', () => {
    const roots = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'tests')];
    const offenders = roots.flatMap((root) =>
      listProductionSourceFiles(root).flatMap((filePath) =>
        retiredPublicationEdges(filePath).map(
          (edge) => `${filePath.slice(REPO_ROOT.length + 1)} contains a retired ${edge}`,
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
