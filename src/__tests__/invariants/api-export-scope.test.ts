import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const API_PATH = fileURLToPath(new URL('../../coordinator/api.ts', import.meta.url));
const FORBIDDEN_REEXPORTS = new Set(['AbortRegistry', 'parseAgentMeta', 'parseAgentRef', 'resolveAgent']);

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
    : false;
}

function nameForExportSpecifier(element: ts.ExportSpecifier): string {
  return element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text;
}

describe('coordinator api export scope invariant (AC12)', () => {
  it('keeps coordinator/api.ts non-empty and free of forbidden shell re-exports', () => {
    const sourceFile = ts.createSourceFile(
      API_PATH,
      readFileSync(API_PATH, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const exportDeclarations = sourceFile.statements.filter(
      (statement) => hasExportModifier(statement) || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement),
    );

    expect(exportDeclarations.length).toBeGreaterThan(0);

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
});
