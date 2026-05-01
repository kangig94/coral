import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const COORDINATOR_ROOT_PATH = join(REPO_ROOT, 'src/coordinator/index.ts');
const CONTRACTS_PATH = join(REPO_ROOT, 'src/coordinator/contracts.ts');
const FORBIDDEN_COORDINATOR_ROOT_EXPORTS = new Set([
  'createCoordinatorCore',
  'listInstantiatedExecutionServices',
  'CoordinatorBootSnapshot',
  'CoordinatorCoreOptions',
  'CoordinatorCoreResult',
  'CreateServerFn',
  'FetchFn',
]);
const FORBIDDEN_CONTRACT_IMPORTS = [
  './control.js',
  './execution-service.js',
  '../transport/server-ports.js',
  './transport/server-ports.js',
  '../jobs/store.js',
  '../providers/registry.js',
];

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false;
}

function collectExportNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        continue;
      }
      names.push(...statement.exportClause.elements.map((element) => element.name.text));
      continue;
    }

    if (!hasExportModifier(statement)) {
      continue;
    }

    if (
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) {
        names.push(statement.name.text);
      }
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    }
  }

  return names;
}

describe('coordinator api export scope invariant', () => {
  it('keeps coordinator/contracts.ts free of transport, live, and service implementation imports', () => {
    const sourceFile = ts.createSourceFile(
      CONTRACTS_PATH,
      readFileSync(CONTRACTS_PATH, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const importPaths = sourceFile.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        return [];
      }
      return [statement.moduleSpecifier.text];
    });

    const forbidden = importPaths.filter(
      (importPath) =>
        FORBIDDEN_CONTRACT_IMPORTS.includes(importPath) ||
        importPath.includes('/live/') ||
        importPath.includes('/shell/'),
    );

    expect(
      forbidden,
      'src/coordinator/contracts.ts must remain a leaf and avoid control, execution-service, live, shell, and transport/server-ports imports',
    ).toEqual([]);
  });

  it('keeps coordinator/index.ts as a composition root, not a composition barrel', () => {
    const sourceFile = ts.createSourceFile(
      COORDINATOR_ROOT_PATH,
      readFileSync(COORDINATOR_ROOT_PATH, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const exportedNames = collectExportNames(sourceFile);
    const forbidden = exportedNames.filter((name) => FORBIDDEN_COORDINATOR_ROOT_EXPORTS.has(name));

    expect(forbidden, 'src/coordinator/index.ts must not re-export composition helpers or types').toEqual([]);
  });
});
