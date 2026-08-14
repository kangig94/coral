import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHUTDOWN_PATH = 'src/coordinator/shutdown.ts';
const LIFECYCLE_PATH = 'src/coordinator/lifecycle.ts';
const ADMISSION_PATH = 'src/coordinator/live/admission.ts';
const FIXTURE_ROOT = 'tests/invariants/fixtures/shutdown-teardown-containment';

const SHUTDOWN_BUDGETED_HELPERS = new Set(['runBudgetedStep', 'runRequiredBudgetedStep']);
const SHUTDOWN_NON_BLOCKING_STEP_TASKS = new Set([
  'server.closeAllConnections',
  'state.ownershipCheckerTeardown',
  'store.dispose',
  'stream.end',
  'terminateAllFn',
]);
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

function containsAwaitOrValueReturn(node: ts.Block): boolean {
  let match = false;

  function visit(current: ts.Node): void {
    if (match) return;
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isAwaitExpression(current) || (ts.isReturnStatement(current) && current.expression !== undefined)) {
      match = true;
      return;
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return match;
}

function isDeadlineAwareInflightDrain(call: ts.CallExpression): boolean {
  if (expressionName(call.expression) !== 'waitForInflightDrain' || call.arguments.length !== 3) return false;

  const remainingBudget = unwrapExpression(call.arguments[1]);
  return ts.isCallExpression(remainingBudget) && expressionName(remainingBudget.expression) === 'remainingDrain';
}

function isNonBlockingRunStep(call: ts.CallExpression): boolean {
  const task = call.arguments[1] && unwrapExpression(call.arguments[1]);
  if (task === undefined) return false;
  if (ts.isIdentifier(task)) return SHUTDOWN_NON_BLOCKING_STEP_TASKS.has(task.text);
  if (!ts.isArrowFunction(task) && !ts.isFunctionExpression(task)) return false;
  if (ts.isBlock(task.body)) return !containsAwaitOrValueReturn(task.body);

  const result = unwrapExpression(task.body);
  if (!ts.isCallExpression(result)) return false;
  const target = expressionName(result.expression);
  return isDeadlineAwareInflightDrain(result) || (target !== null && SHUTDOWN_NON_BLOCKING_STEP_TASKS.has(target));
}

function enclosingShutdownHelper(node: ts.AwaitExpression, shutdownPath: NamedFunction): ts.CallExpression | null {
  const expression = unwrapExpression(node.expression);
  if (ts.isCallExpression(expression)) {
    const directTarget = expressionName(expression.expression);
    if (directTarget === 'runStep' || (directTarget !== null && SHUTDOWN_BUDGETED_HELPERS.has(directTarget))) {
      return expression;
    }
  }

  for (let current = node.parent; current && current !== shutdownPath; current = current.parent) {
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
      if (helper === 'runStep' || (helper !== null && SHUTDOWN_BUDGETED_HELPERS.has(helper))) return parent;
    }
    return null;
  }

  return null;
}

function shutdownAwaitViolation(node: ts.AwaitExpression, shutdownPath: NamedFunction): string | null {
  const expression = unwrapExpression(node.expression);
  const exactCall = exactSingleIdentifierCall(expression);
  if (exactCall !== null && SHUTDOWN_NON_FINALIZER_AWAIT_ALLOWLIST.has(exactCall)) return null;

  const helperCall = enclosingShutdownHelper(node, shutdownPath);
  const helper = helperCall === null ? null : expressionName(helperCall.expression);
  if (helper !== null && SHUTDOWN_BUDGETED_HELPERS.has(helper)) return null;
  if (helper === 'runStep' && helperCall !== null && isNonBlockingRunStep(helperCall)) return null;
  if (helper === 'runStep') {
    return `plain runStep has no shutdown deadline; use ${[...SHUTDOWN_BUDGETED_HELPERS].join(' or ')}`;
  }
  return `await ${awaitedExpressionLabel(node)} bypasses shutdown containment`;
}

function formatViolation(functionNode: NamedFunction, node: ts.Node, detail: string): string {
  const sourceFile = functionNode.getSourceFile();
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName}:${line + 1} ${functionName(functionNode)}: ${detail}`;
}

function shutdownAwaitViolations(sourceFile: ts.SourceFile, functionName = 'runShutdownSequence'): string[] {
  const shutdownSequence = findFunction(sourceFile, functionName);
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isAwaitExpression(node)) {
      const violation = shutdownAwaitViolation(node, shutdownSequence);
      if (violation !== null) violations.push(formatViolation(shutdownSequence, node, violation));
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
    expect([
      ...shutdownAwaitViolations(readSource(SHUTDOWN_PATH)),
      ...shutdownAwaitViolations(readSource(LIFECYCLE_PATH), 'shutdown'),
    ]).toEqual([]);
  });

  it('rejects a bare awaited shutdown finalizer mutation', () => {
    expect(shutdownAwaitViolations(readFixture('shutdown-bare-await'))).toEqual([
      `${FIXTURE_ROOT}/shutdown-bare-await.ts:2 runShutdownSequence: await terminateAllFn() bypasses shutdown containment`,
    ]);
  });

  it('rejects a potentially blocking finalizer inside plain runStep', () => {
    const mutation = parseSource(
      SHUTDOWN_PATH,
      `async function runShutdownSequence() {
        await runStep('provider operation reconciler drain', stopProviderOperationReconciler);
      }`,
    );
    expect(shutdownAwaitViolations(mutation)).toEqual([
      `${SHUTDOWN_PATH}:2 runShutdownSequence: ` +
        'plain runStep has no shutdown deadline; use runBudgetedStep or runRequiredBudgetedStep',
    ]);
  });

  it('rejects a bare awaited finalizer in the lifecycle stopped-state path', () => {
    const mutation = parseSource(
      LIFECYCLE_PATH,
      `function createLifecycle() {
        async function shutdown() {
          await stopProviderOperationReconciler('drain');
        }
      }`,
    );
    expect(shutdownAwaitViolations(mutation, 'shutdown')).toEqual([
      `${LIFECYCLE_PATH}:3 shutdown: await stopProviderOperationReconciler() bypasses shutdown containment`,
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
