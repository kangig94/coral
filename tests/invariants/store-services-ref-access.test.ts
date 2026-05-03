import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');
const STORE_SERVICES_REF_HOME = 'src/coordinator/composition/store-services-ref.ts';

type StoreServicesRefCall = {
  relativePath: string;
  line: number;
  method: 'tryGet' | 'get' | 'set';
  receiver: string;
  enclosingFunctions: readonly string[];
};

function toRepoPath(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split('\\').join('/');
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        return listSourceFiles(path);
      }
      return path.endsWith('.ts') ? [path] : [];
    })
    .sort();
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function collectStoreServicesRefIdentifiers(source: ts.SourceFile): Set<string> {
  const identifiers = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      const typeText = node.type?.getText(source) ?? '';
      const initializerText = ts.isVariableDeclaration(node) ? (node.initializer?.getText(source) ?? '') : '';
      if (typeText.includes('StoreServicesRef') || initializerText.includes('createStoreServicesRef(')) {
        identifiers.add(node.name.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return identifiers;
}

function expressionLooksLikeStoreServicesRef(
  expression: ts.Expression,
  source: ts.SourceFile,
  localRefIdentifiers: ReadonlySet<string>,
): boolean {
  if (ts.isIdentifier(expression) && localRefIdentifiers.has(expression.text)) {
    return true;
  }

  const text = expression.getText(source);
  const normalized = text.replace(/[^A-Za-z]/g, '').toLowerCase();
  return normalized.includes('storeservicesref') || normalized.includes('storeservices');
}

function functionName(node: ts.Node, _source: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && node.name) {
    return propertyNameText(node.name);
  }
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) {
    return ts.isIdentifier(node.parent.name) ? node.parent.name.text : null;
  }
  return null;
}

function enclosingFunctionNames(node: ts.Node, source: ts.SourceFile): string[] {
  const names: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    const name = functionName(current, source);
    if (name !== null) {
      names.push(name);
    }
    current = current.parent;
  }
  return names;
}

function collectStoreServicesRefCalls(absolutePath: string): StoreServicesRefCall[] {
  const relativePath = toRepoPath(absolutePath);
  if (relativePath === STORE_SERVICES_REF_HOME) {
    return [];
  }

  const sourceText = readFileSync(absolutePath, 'utf8');
  const source = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
  const localRefIdentifiers = collectStoreServicesRefIdentifiers(source);
  const calls: StoreServicesRefCall[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (
        (method === 'tryGet' || method === 'get' || method === 'set') &&
        expressionLooksLikeStoreServicesRef(node.expression.expression, source, localRefIdentifiers)
      ) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        calls.push({
          relativePath,
          line: position.line + 1,
          method,
          receiver: node.expression.expression.getText(source),
          enclosingFunctions: enclosingFunctionNames(node, source),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return calls;
}

function isHealthOrHandoffIdentityFile(relativePath: string, sourceText: string): boolean {
  if (relativePath === STORE_SERVICES_REF_HOME) {
    return false;
  }

  const isHealthFile = sourceText.includes('/health') || sourceText.includes('transport.health');
  const lower = sourceText.toLowerCase();
  const isHandoffIdentityFile =
    lower.includes('handoff') &&
    (lower.includes('identity') || lower.includes('compatible') || lower.includes('incumbent'));
  return isHealthFile || isHandoffIdentityFile;
}

function allSrcFiles(): string[] {
  return listSourceFiles(SRC_ROOT);
}

describe('store services ref access invariants', () => {
  it('exports StoreServicesRef and CoordinatorStoreServices from one canonical src home', () => {
    const definitions = allSrcFiles().flatMap((absolutePath) => {
      const source = readFileSync(absolutePath, 'utf8');
      const relativePath = toRepoPath(absolutePath);
      const matches: string[] = [];
      if (/\bexport\s+interface\s+CoordinatorStoreServices\b/.test(source)) {
        matches.push(`${relativePath}:CoordinatorStoreServices`);
      }
      if (/\bexport\s+interface\s+StoreServicesRef\b/.test(source)) {
        matches.push(`${relativePath}:StoreServicesRef`);
      }
      return matches;
    });

    expect(definitions).toEqual([
      `${STORE_SERVICES_REF_HOME}:CoordinatorStoreServices`,
      `${STORE_SERVICES_REF_HOME}:StoreServicesRef`,
    ]);
  });

  it('uses only tryGet() for StoreServicesRef access in health and handoff identity code', () => {
    const violations = allSrcFiles().flatMap((absolutePath) => {
      const sourceText = readFileSync(absolutePath, 'utf8');
      const relativePath = toRepoPath(absolutePath);
      if (!isHealthOrHandoffIdentityFile(relativePath, sourceText)) {
        return [];
      }
      return collectStoreServicesRefCalls(absolutePath)
        .filter(
          (call) =>
            call.method !== 'tryGet' &&
            !(call.method === 'set' && call.enclosingFunctions.includes('runLifecycleStartup')),
        )
        .map((call) => `${call.relativePath}:${call.line} ${call.receiver}.${call.method}()`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps production StoreServicesRef writers in runLifecycleStartup and test injector out of src', () => {
    const files = allSrcFiles();
    const testInjectorReferences = files
      .filter((absolutePath) => readFileSync(absolutePath, 'utf8').includes('setStoreServicesForTest'))
      .map(toRepoPath);
    const writerViolations = files
      .flatMap(collectStoreServicesRefCalls)
      .filter((call) => call.method === 'set')
      .filter((call) => !call.enclosingFunctions.includes('runLifecycleStartup'))
      .map((call) => `${call.relativePath}:${call.line} ${call.receiver}.set()`);

    expect(testInjectorReferences).toEqual([]);
    expect(writerViolations).toEqual([]);
  });
});
