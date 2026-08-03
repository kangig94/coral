import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHUTDOWN_PATH = 'src/coordinator/shutdown.ts';
const ADMISSION_PATH = 'src/coordinator/live/admission.ts';
const FIXTURE_ROOT = 'tests/invariants/fixtures/shutdown-teardown-containment';

const SHUTDOWN_CONTAINMENT_HELPERS = new Set(['runStep', 'runBudgetedStep']);
const SHUTDOWN_NON_FINALIZER_AWAIT_ALLOWLIST = new Set([
  'waitForObservedShutdownTask(serverClosed)',
  'waitForObservedShutdownTask(ipcServerClosed)',
]);

type NamedFunction = ts.FunctionDeclaration | ts.MethodDeclaration;

function parseSource(canonicalPath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(canonicalPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function readSource(canonicalPath: string): ts.SourceFile {
  return parseSource(canonicalPath, readFileSync(resolve(REPO_ROOT, canonicalPath), 'utf8'));
}

function readFixture(name: string): ts.SourceFile {
  const fixturePath = `${FIXTURE_ROOT}/${name}.ts`;
  const source = readFileSync(resolve(REPO_ROOT, `${fixturePath}.txt`), 'utf8');
  return parseSource(fixturePath, source);
}

function functionName(node: NamedFunction): string | null {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

function findFunction(sourceFile: ts.SourceFile, name: string): NamedFunction {
  let match: NamedFunction | undefined;

  function visit(node: ts.Node): void {
    if (
      match === undefined &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      functionName(node) === name
    ) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!match) {
    throw new Error(`${sourceFile.fileName}: expected function ${name}`);
  }
  return match;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionName(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return current.text;
  if (current.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (!ts.isPropertyAccessExpression(current)) return null;

  const owner = expressionName(current.expression);
  return owner === null ? null : `${owner}.${current.name.text}`;
}

function awaitedExpressionLabel(node: ts.AwaitExpression): string {
  const expression = unwrapExpression(node.expression);
  if (ts.isCallExpression(expression)) {
    const callee = expressionName(expression.expression) ?? expression.expression.getText(node.getSourceFile());
    return `${callee}()`;
  }
  return expressionName(expression) ?? expression.getText(node.getSourceFile());
}

function exactSingleIdentifierCall(expression: ts.Expression): string | null {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current) || current.arguments.length !== 1) return null;

  const target = expressionName(current.expression);
  const argument = unwrapExpression(current.arguments[0]);
  if (target === null || !ts.isIdentifier(argument)) return null;
  return `${target}(${argument.text})`;
}

function isContainedAwait(node: ts.AwaitExpression, shutdownSequence: NamedFunction): boolean {
  const expression = unwrapExpression(node.expression);
  const directTarget = ts.isCallExpression(expression) ? expressionName(expression.expression) : null;
  const exactCall = exactSingleIdentifierCall(expression);
  if (
    (directTarget !== null && SHUTDOWN_CONTAINMENT_HELPERS.has(directTarget)) ||
    (exactCall !== null && SHUTDOWN_NON_FINALIZER_AWAIT_ALLOWLIST.has(exactCall))
  ) {
    return true;
  }

  for (let current = node.parent; current && current !== shutdownSequence; current = current.parent) {
    if (
      !ts.isArrowFunction(current) &&
      !ts.isFunctionExpression(current) &&
      !ts.isFunctionDeclaration(current) &&
      !ts.isMethodDeclaration(current)
    ) {
      continue;
    }

    const parent = current.parent;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(parent) &&
      parent.arguments[1] !== undefined &&
      unwrapExpression(parent.arguments[1]) === current
    ) {
      const helper = expressionName(parent.expression);
      if (helper !== null && SHUTDOWN_CONTAINMENT_HELPERS.has(helper)) return true;
    }
    return false;
  }

  return false;
}

function formatViolation(functionNode: NamedFunction, node: ts.Node, detail: string): string {
  const sourceFile = functionNode.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${line + 1} ${functionName(functionNode)}: ${detail}`;
}

function shutdownAwaitViolations(sourceFile: ts.SourceFile): string[] {
  const shutdownSequence = findFunction(sourceFile, 'runShutdownSequence');
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isAwaitExpression(node) && !isContainedAwait(node, shutdownSequence)) {
      violations.push(
        formatViolation(
          shutdownSequence,
          node,
          `await ${awaitedExpressionLabel(node)} bypasses containment helpers runStep and runBudgetedStep`,
        ),
      );
    }
    ts.forEachChild(node, visit);
  }

  if (shutdownSequence.body) visit(shutdownSequence.body);
  return violations;
}

function cleanupHandleLoop(terminateAll: NamedFunction): ts.ForOfStatement | null {
  let match: ts.ForOfStatement | null = null;

  function visit(node: ts.Node): void {
    if (match !== null) return;
    if (ts.isForOfStatement(node)) {
      const iterable = unwrapExpression(node.expression);
      if (ts.isCallExpression(iterable) && expressionName(iterable.expression) === 'this.cleanupHandles.values') {
        match = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  }

  if (terminateAll.body) visit(terminateAll.body);
  return match;
}

function loopBindingName(loop: ts.ForOfStatement): string | null {
  if (!ts.isVariableDeclarationList(loop.initializer)) return null;
  const declaration = loop.initializer.declarations[0];
  return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
}

function isInsideCaughtTry(node: ts.Node, loop: ts.ForOfStatement): boolean {
  for (let current = node.parent; current && current !== loop; current = current.parent) {
    if (ts.isTryStatement(current) && current.catchClause !== undefined) {
      for (let ancestor = node.parent; ancestor && ancestor !== current; ancestor = ancestor.parent) {
        if (ancestor === current.tryBlock) return true;
      }
    }
  }
  return false;
}

function childTerminationViolations(sourceFile: ts.SourceFile): string[] {
  const terminateAll = findFunction(sourceFile, 'terminateAll');
  const loop = cleanupHandleLoop(terminateAll);
  if (loop === null) {
    return [formatViolation(terminateAll, terminateAll, 'missing cleanupHandles.values() termination loop')];
  }

  const cleanupName = loopBindingName(loop);
  if (cleanupName === null) {
    return [formatViolation(terminateAll, loop, 'cleanup handle loop must use an exact identifier binding')];
  }

  const cleanupCalls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(unwrapExpression(node.expression)) &&
      expressionName(node.expression) === cleanupName
    ) {
      cleanupCalls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(loop.statement);

  if (cleanupCalls.length === 0) {
    return [formatViolation(terminateAll, loop, `cleanup handle ${cleanupName} is never called`)];
  }

  return cleanupCalls
    .filter((call) => !isInsideCaughtTry(call, loop))
    .map((call) => formatViolation(terminateAll, call, `${cleanupName}() bypasses per-handle try/catch containment`));
}

describe('shutdown teardown containment invariant', () => {
  it('contains every awaited shutdown finalizer or names an exact non-finalizer await', () => {
    expect(shutdownAwaitViolations(readSource(SHUTDOWN_PATH))).toEqual([]);
  });

  it('rejects a bare awaited shutdown finalizer mutation', () => {
    expect(shutdownAwaitViolations(readFixture('shutdown-bare-await'))).toEqual([
      `${FIXTURE_ROOT}/shutdown-bare-await.ts:2 runShutdownSequence: ` +
        'await terminateAllFn() bypasses containment helpers runStep and runBudgetedStep',
    ]);
  });

  it('contains every cleanup call in the child-termination loop', () => {
    expect(childTerminationViolations(readSource(ADMISSION_PATH))).toEqual([]);
  });

  it('rejects a bare child-cleanup mutation', () => {
    expect(childTerminationViolations(readFixture('terminate-all-bare-cleanup'))).toEqual([
      `${FIXTURE_ROOT}/terminate-all-bare-cleanup.ts:4 terminateAll: ` +
        'cleanup() bypasses per-handle try/catch containment',
    ]);
  });
});
