import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  listProductionSourceFiles,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const COORDINATOR_ROOT_PATH = join(REPO_ROOT, 'src/coordinator/coordinator.ts');
const CONTRACTS_PATH = join(REPO_ROOT, 'src/coordinator/contracts.ts');
const FORBIDDEN_COORDINATOR_ROOT_EXPORTS = new Set([
  'createBackendCore',
  'listInstantiatedExecutionServices',
  'BackendBootSnapshot',
  'BackendCoreOptions',
  'BackendCoreResult',
  'CreateServerFn',
  'FetchFn',
]);
const FORBIDDEN_CONTRACT_IMPORTS = [
  './control.js',
  './execution-service.js',
  '../transport/http/contracts.js',
  './transport/http/contracts.js',
  '../jobs/job-store.js',
  '../providers/registry.js',
];
const OPEN_SHARD_ALLOWLIST = new Set(['src/sessions/shell/resolve.ts', 'src/jobs/reconcile/snapshot.ts']);

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

describe('coordinator api export scope invariant (AC12)', () => {
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
      'src/coordinator/contracts.ts must remain a leaf and avoid control, execution-service, live, shell, and transport/http/contracts imports',
    ).toEqual([]);
  });

  it('keeps coordinator/coordinator.ts as a composition root, not a composition barrel', () => {
    const sourceFile = ts.createSourceFile(
      COORDINATOR_ROOT_PATH,
      readFileSync(COORDINATOR_ROOT_PATH, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const exportedNames = collectExportNames(sourceFile);
    const forbidden = exportedNames.filter((name) => FORBIDDEN_COORDINATOR_ROOT_EXPORTS.has(name));

    expect(
      forbidden,
      'src/coordinator/coordinator.ts must not re-export backend-core composition helpers or types',
    ).toEqual([]);
  });

  it('keeps SessionManager.openShard usage inside the recovery/read allowlist', () => {
    const violations: string[] = [];

    for (const filePath of listProductionSourceFiles(SRC_ROOT)) {
      const canonicalPath = toCanonicalSrcPath(REPO_ROOT, filePath);
      const sourceFile = ts.createSourceFile(
        filePath,
        readFileSync(filePath, 'utf-8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      let hasOpenShardCall = false;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          ts.isIdentifier(node.expression.name) &&
          node.expression.expression.text === 'SessionManager' &&
          node.expression.name.text === 'openShard'
        ) {
          hasOpenShardCall = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      if (hasOpenShardCall && !OPEN_SHARD_ALLOWLIST.has(canonicalPath)) {
        violations.push(canonicalPath);
      }
    }

    expect(violations, 'Production SessionManager.openShard sites must stay confined to the allowlist.').toEqual([]);
  });
});
