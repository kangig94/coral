import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  listProductionSourceFiles,
  parseProductionImportEdges,
  toCanonicalSrcPath,
} from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const PRODUCTION_IMPORT_EDGES = parseProductionImportEdges(REPO_ROOT, PRODUCTION_FILE_PATHS);
const API_PATH = join(REPO_ROOT, 'src/coordinator/api.ts');
const JOBS_API_PATH = join(REPO_ROOT, 'src/jobs/api.ts');
const WORKFLOW_API_PATH = join(REPO_ROOT, 'src/workflow/api.ts');
const COORDINATOR_ROOT_PATH = join(REPO_ROOT, 'src/coordinator/coordinator.ts');
const CONTRACTS_PATH = join(REPO_ROOT, 'src/coordinator/contracts.ts');
const FORBIDDEN_REEXPORTS = new Set(['AbortRegistry', 'parseAgentMeta', 'parseAgentRef', 'resolveAgent']);
const FORBIDDEN_COORDINATOR_ROOT_EXPORTS = new Set([
  'createBackendCore',
  'listInstantiatedExecutionServices',
  'BackendBootSnapshot',
  'BackendCoreOptions',
  'BackendCoreResult',
  'CreateServerFn',
  'FetchFn',
]);
const ALLOWED_WORKFLOW_API_EXPORT_TARGETS = new Set(['./input.js', './compile.js', './dispatch.js', './startup.js']);
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

function collectExportTargets(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return [];
    }
    return [statement.moduleSpecifier.text];
  });
}

function collectNonExportStatements(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (ts.isExportDeclaration(statement)) {
      return [];
    }
    return [ts.SyntaxKind[statement.kind] ?? String(statement.kind)];
  });
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
        const names = [element.name.text, element.propertyName?.text].filter(
          (value): value is string => value !== undefined,
        );
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

  it('keeps jobs/api.ts as a thin startup facade', () => {
    const sourceFile = ts.createSourceFile(
      JOBS_API_PATH,
      readFileSync(JOBS_API_PATH, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(collectNonExportStatements(sourceFile), 'src/jobs/api.ts must contain only re-export declarations').toEqual(
      [],
    );
    expect(collectExportTargets(sourceFile), 'src/jobs/api.ts must only re-export the direct startup owner').toEqual([
      './startup.js',
    ]);

    const exportNames = collectExportNames(sourceFile);
    expect(exportNames).not.toContain('ProgressStore');
  });

  it('keeps workflow/api.ts as a thin facade over workflow owners', () => {
    const sourceFile = ts.createSourceFile(
      WORKFLOW_API_PATH,
      readFileSync(WORKFLOW_API_PATH, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(
      collectNonExportStatements(sourceFile),
      'src/workflow/api.ts must contain only re-export declarations',
    ).toEqual([]);

    const exportTargets = collectExportTargets(sourceFile);
    expect(
      exportTargets.every((target) => ALLOWED_WORKFLOW_API_EXPORT_TARGETS.has(target)),
      `src/workflow/api.ts must only re-export from ${[...ALLOWED_WORKFLOW_API_EXPORT_TARGETS].join(', ')}`,
    ).toBe(true);

    const unexpectedTargets = exportTargets.filter((target) => !ALLOWED_WORKFLOW_API_EXPORT_TARGETS.has(target));
    expect(unexpectedTargets).toEqual([]);
  });

  it('keeps jobs/api.ts and workflow/api.ts out of the production import graph', () => {
    const façadeTargets = new Set(['src/jobs/api.ts', 'src/workflow/api.ts']);
    const importingEdges = PRODUCTION_IMPORT_EDGES.filter(({ target }) => façadeTargets.has(target)).map(
      ({ source, target, specifier, via }) => `${source} -> ${target} via ${via} (${specifier})`,
    );

    expect(importingEdges, 'Production code must import direct workflow/jobs owners instead of api.ts facades').toEqual(
      [],
    );
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
