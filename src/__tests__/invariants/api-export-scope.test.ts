import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const API_PATH = fileURLToPath(new URL('../../coordinator/api.ts', import.meta.url));
const CONTRACTS_PATH = fileURLToPath(new URL('../../coordinator/contracts.ts', import.meta.url));
const FORBIDDEN_REEXPORTS = new Set(['AbortRegistry', 'parseAgentMeta', 'parseAgentRef', 'resolveAgent']);
const FORBIDDEN_CONTRACT_IMPORTS = [
  './control.js',
  './execution-service.js',
  '../transport/http/contracts.js',
  './transport/http/contracts.js',
];

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false;
}

function nameForExportSpecifier(element: ts.ExportSpecifier): string {
  return element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text;
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
      ts.isClassDeclaration(statement)
      || ts.isFunctionDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)
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

describe('coordinator api export scope invariant (AC12)', () => {
  it('keeps coordinator/api.ts as a narrow seam with no forbidden shell re-exports', () => {
    const sourceFile = ts.createSourceFile(
      API_PATH,
      readFileSync(API_PATH, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const exportNames = collectExportNames(sourceFile);

    expect(exportNames.length).toBeGreaterThan(0);
    expect(exportNames.length, 'src/coordinator/api.ts must stay a tiny re-export seam').toBeLessThanOrEqual(10);

    const forbidden = sourceFile.statements.flatMap((statement) => {
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
        return [];
      }

      return statement.exportClause.elements.flatMap((element) => {
        const names = [element.name.text, element.propertyName?.text].filter((value): value is string => value !== undefined);
        return names.some((name) => FORBIDDEN_REEXPORTS.has(name)) ? [nameForExportSpecifier(element)] : [];
      });
    });

    expect(forbidden, 'src/coordinator/api.ts must not re-export shell implementation symbols').toEqual([]);
  });

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
      (importPath) => FORBIDDEN_CONTRACT_IMPORTS.includes(importPath) || importPath.includes('/live/') || importPath.includes('/shell/'),
    );

    expect(
      forbidden,
      'src/coordinator/contracts.ts must remain a leaf and avoid control, execution-service, live, shell, and transport/http/contracts imports',
    ).toEqual([]);
  });
});
