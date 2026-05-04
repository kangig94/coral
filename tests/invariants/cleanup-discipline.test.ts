import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');
const PRODUCTION_FILE_PATHS = listProductionSourceFiles(SRC_ROOT);
const PRODUCTION_SOURCE_FILES = PRODUCTION_FILE_PATHS.map((filePath) => ({
  absolutePath: filePath,
  canonicalPath: toCanonicalSrcPath(REPO_ROOT, filePath),
}));

const LIFECYCLE_REACTOR = 'src/sessions/lifecycle-reactor.ts';
const RETIRED_WORKFLOW_CLEANUP_MODULE = 'src/coordinator/workflow-cleanup.ts';
const CLEANUP_METHOD_NAMES = new Set(['cleanupSessions', 'discardArtifacts']);
const DISPOSAL_NAME_PATTERN = /workflow.*(?:cleanup|discard|dispos)|(?:cleanup|discard|dispos).*workflow/iu;

function isProviderFile(canonicalPath: string): boolean {
  return canonicalPath.startsWith('src/providers/');
}

function sourceFile(filePath: string): ts.SourceFile {
  const source = readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function declarationNameText(node: { readonly name?: ts.Node }): string | null {
  const name = node.name;
  return name && ts.isIdentifier(name) ? name.text : null;
}

function hasFunctionLikeInitializer(node: ts.VariableDeclaration): boolean {
  const initializer = node.initializer;
  return (
    initializer !== undefined &&
    (ts.isFunctionExpression(initializer) ||
      ts.isArrowFunction(initializer) ||
      (ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'managed'))
  );
}

function collectArtifactCapabilityDefinitionsOutsideProviders(): string[] {
  const violations: string[] = [];

  for (const { absolutePath, canonicalPath } of PRODUCTION_SOURCE_FILES) {
    if (isProviderFile(canonicalPath)) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (ts.isFunctionDeclaration(node) && CLEANUP_METHOD_NAMES.has(declarationNameText(node) ?? '')) {
        violations.push(`${canonicalPath}: defines function ${declarationNameText(node)}`);
      } else if (ts.isMethodDeclaration(node) && CLEANUP_METHOD_NAMES.has(propertyNameText(node.name) ?? '')) {
        violations.push(`${canonicalPath}: implements method ${propertyNameText(node.name)}`);
      } else if (
        ts.isVariableDeclaration(node) &&
        CLEANUP_METHOD_NAMES.has(declarationNameText(node) ?? '') &&
        hasFunctionLikeInitializer(node)
      ) {
        violations.push(`${canonicalPath}: defines function-valued ${declarationNameText(node)}`);
      } else if (ts.isPropertyAssignment(node) && CLEANUP_METHOD_NAMES.has(propertyNameText(node.name) ?? '')) {
        violations.push(`${canonicalPath}: implements property ${propertyNameText(node.name)}`);
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile(absolutePath));
  }

  return violations.sort();
}

function collectProviderCleanupDirectImports(): string[] {
  const violations: string[] = [];

  for (const { absolutePath, canonicalPath } of PRODUCTION_SOURCE_FILES) {
    function visit(node: ts.Node): void {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) {
        ts.forEachChild(node, visit);
        return;
      }

      const moduleSpecifier = node.moduleSpecifier.text;
      const importsProviderModule =
        moduleSpecifier.startsWith('#src/providers/') ||
        (moduleSpecifier.startsWith('.') && isProviderFile(resolveImport(canonicalPath, moduleSpecifier)));
      if (!importsProviderModule) {
        return;
      }

      const namedBindings = node.importClause?.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) {
        return;
      }

      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (CLEANUP_METHOD_NAMES.has(importedName)) {
          violations.push(`${canonicalPath}: imports ${importedName} from ${moduleSpecifier}`);
        }
      }
    }

    visit(sourceFile(absolutePath));
  }

  return violations.sort();
}

function resolveImport(sourceCanonicalPath: string, specifier: string): string {
  const sourceDir = sourceCanonicalPath.split('/').slice(0, -1).join('/');
  const normalized = join(sourceDir, specifier).split('\\').join('/');
  return normalized.endsWith('.js') ? `${normalized.slice(0, -'.js'.length)}.ts` : normalized;
}

function collectProviderDiscardCallersOutsideReactor(): string[] {
  const violations: string[] = [];

  for (const { absolutePath, canonicalPath } of PRODUCTION_SOURCE_FILES) {
    if (isProviderFile(canonicalPath) || canonicalPath === LIFECYCLE_REACTOR) {
      continue;
    }

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        CLEANUP_METHOD_NAMES.has(node.expression.name.text)
      ) {
        violations.push(`${canonicalPath}: calls ${node.expression.name.text}`);
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile(absolutePath));
  }

  return violations.sort();
}

function collectProductionStringResidue(token: string): string[] {
  return PRODUCTION_SOURCE_FILES.flatMap(({ absolutePath, canonicalPath }) => {
    const source = readFileSync(absolutePath, 'utf8');
    return source.includes(token) ? [canonicalPath] : [];
  });
}

function collectDisposalWorkflowSymbolResidue(): string[] {
  const violations: string[] = [];

  for (const { absolutePath, canonicalPath } of PRODUCTION_SOURCE_FILES) {
    if (DISPOSAL_NAME_PATTERN.test(canonicalPath)) {
      violations.push(`${canonicalPath}: module path`);
    }

    function visit(node: ts.Node): void {
      if (ts.isIdentifier(node) && DISPOSAL_NAME_PATTERN.test(node.text)) {
        violations.push(`${canonicalPath}: identifier ${node.text}`);
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile(absolutePath));
  }

  return violations.sort();
}

describe('cleanup discipline invariants', () => {
  it('keeps the retired coordinator workflow cleanup module deleted', () => {
    expect(existsSync(resolve(REPO_ROOT, RETIRED_WORKFLOW_CLEANUP_MODULE))).toBe(false);
  });

  it('keeps artifact cleanup capability definitions provider-owned', () => {
    expect(collectArtifactCapabilityDefinitionsOutsideProviders()).toEqual([]);
  });

  it('prevents direct provider cleanup imports and caller-side discard invocation', () => {
    expect(collectProviderCleanupDirectImports()).toEqual([]);
    expect(collectProviderDiscardCallersOutsideReactor()).toEqual([]);
  });

  it('keeps retired cleanup workflow naming out of production sources', () => {
    expect(collectProductionStringResidue('cleanupWorkflowSessions')).toEqual([]);
  });

  it('keeps provider cleanup and reactor retention names honest', () => {
    const providerContract = readFileSync(resolve(REPO_ROOT, 'src/providers/contract.ts'), 'utf8');
    expect(providerContract).toContain('discardArtifacts(');
    expect(providerContract).not.toContain('cleanupSessions');

    const reactor = readFileSync(resolve(REPO_ROOT, LIFECYCLE_REACTOR), 'utf8');
    expect(reactor).toContain('enforceRetention(sessionId: string, jobId: string)');
    expect(reactor).not.toContain('disposeSession');

    expect(collectDisposalWorkflowSymbolResidue()).toEqual([]);
  });
});
