import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const SRC_ROOT = join(REPO_ROOT, 'src');

type DbOpenCall = {
  relativePath: string;
  line: number;
  callee: 'openStoreDatabase' | 'openBackendStoreDb';
  staticallyReadOnlyOrMemory: boolean;
};

const EXPLICIT_ALLOWLIST = new Set([
  // Store factory internals are the source of truth for opening backend-store DBs.
  'src/store/db.ts:openStoreDatabase',
]);

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

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function objectLiteralStaticallyReadOnlyOrMemory(expr: ts.ObjectLiteralExpression): boolean {
  let hasReadonlyTrue = false;
  let hasMemoryPath = false;

  for (const property of expr.properties) {
    if (ts.isSpreadAssignment(property) || !ts.isPropertyAssignment(property)) {
      return false;
    }

    const name = propertyNameText(property.name);
    const initializer = unwrapExpression(property.initializer);
    if (name === 'readonly') {
      hasReadonlyTrue = initializer.kind === ts.SyntaxKind.TrueKeyword;
    }
    if (name === 'path') {
      hasMemoryPath = ts.isStringLiteral(initializer) && initializer.text === ':memory:';
    }
  }

  return hasReadonlyTrue || hasMemoryPath;
}

function staticallyReadOnlyOrMemory(expr: ts.Expression | undefined): boolean {
  if (expr === undefined) {
    return false;
  }

  const unwrapped = unwrapExpression(expr);
  if (ts.isObjectLiteralExpression(unwrapped)) {
    return objectLiteralStaticallyReadOnlyOrMemory(unwrapped);
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return (
      staticallyReadOnlyOrMemory(unwrapped.whenTrue) &&
      staticallyReadOnlyOrMemory(unwrapped.whenFalse)
    );
  }
  return false;
}

function collectDbOpenCalls(): DbOpenCall[] {
  const calls: DbOpenCall[] = [];
  for (const absolutePath of listSourceFiles(SRC_ROOT)) {
    const sourceText = readFileSync(absolutePath, 'utf8');
    const source = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true);
    const relativePath = relative(REPO_ROOT, absolutePath);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (callee === 'openStoreDatabase' || callee === 'openBackendStoreDb') {
          const position = source.getLineAndCharacterOfPosition(node.getStart(source));
          calls.push({
            relativePath,
            line: position.line + 1,
            callee,
            staticallyReadOnlyOrMemory:
              callee === 'openStoreDatabase' && staticallyReadOnlyOrMemory(node.arguments[0]),
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }
  return calls;
}

describe('writable DB opens stay coordinator-owned', () => {
  it('forbids writable backend-store opens outside coordinator composition and documented bootstrap exceptions', () => {
    const violations = collectDbOpenCalls().filter((call) => {
      if (call.relativePath.startsWith('src/coordinator/')) {
        return false;
      }
      if (EXPLICIT_ALLOWLIST.has(`${call.relativePath}:${call.callee}`)) {
        return false;
      }
      return !call.staticallyReadOnlyOrMemory;
    });

    expect(violations).toEqual([]);
  });

  it('keeps read-store as the canonical static-proof no-disk fallback example', () => {
    const readStoreCalls = collectDbOpenCalls().filter((call) => call.relativePath === 'src/cli/read-store.ts');

    expect(readStoreCalls).toEqual([
      expect.objectContaining({ callee: 'openStoreDatabase', staticallyReadOnlyOrMemory: true }),
      expect.objectContaining({ callee: 'openStoreDatabase', staticallyReadOnlyOrMemory: true }),
    ]);
  });

  it('does not expose a raw db member on the KbRuntime contract or its inheritance chain', () => {
    const contractSource = readFileSync(join(REPO_ROOT, 'src/kb/contract.ts'), 'utf8');
    const source = ts.createSourceFile('contract.ts', contractSource, ts.ScriptTarget.Latest, true);

    const interfaceDecls = new Map<string, ts.InterfaceDeclaration>();
    const collect = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        interfaceDecls.set(node.name.text, node);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);

    const seen = new Set<string>();
    const violations: string[] = [];

    function walk(name: string): void {
      if (seen.has(name)) return;
      seen.add(name);
      const decl = interfaceDecls.get(name);
      if (decl === undefined) return;

      for (const member of decl.members) {
        if (ts.isPropertySignature(member) && member.name && propertyNameText(member.name) === 'db') {
          violations.push(`${name}.db`);
        }
      }

      for (const heritage of decl.heritageClauses ?? []) {
        if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const clause of heritage.types) {
          if (ts.isIdentifier(clause.expression)) {
            walk(clause.expression.text);
          }
        }
      }
    }

    walk('KbRuntime');
    expect(violations).toEqual([]);
    expect(contractSource).not.toMatch(/KbRuntime\s*\[\s*['"]db['"]\s*\]/);
  });
});
