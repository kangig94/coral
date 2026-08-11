import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const PROXY_FILE = join(REPO_ROOT, 'src/provider-proxy/proxy.ts');
const SUPERVISOR_FILE = join(REPO_ROOT, 'src/provider-proxy/operation-supervisor.ts');

const SUPERVISOR_ALLOWED_CALLS = new Set([
  'proxyOperationStatusResultSchema.shape.operations.parse',
  'operations.map',
  'this.#operations.get',
  'operationToken',
  'sameOperation',
  'this.#ledger.get',
]);
const SUPERVISOR_REQUIRED_CALLS = new Set([
  'proxyOperationStatusResultSchema.shape.operations.parse',
  'this.#operations.get',
  'sameOperation',
  'this.#ledger.get',
]);
const HANDLER_ALLOWED_CALLS = new Set([
  'statusParamsSchema.parse',
  'assertNamedOperation',
  'statusResultSchema.parse',
  'supervisor.status',
]);
const HANDLER_REQUIRED_CALLS = new Set(HANDLER_ALLOWED_CALLS);

const MUTATING_HELPERS = new Set([
  '#driveRelease',
  '#beginRelease',
  '#clearDeadline',
  '#scheduleReleaseRetry',
  '#abortOwnedHandles',
  '#startAbort',
  'abortAndRelease',
]);
const TIMER_AND_QUEUE_CALLS = new Set([
  '#enqueue',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'queueMicrotask',
]);

type StatusMethodEntry = Readonly<{
  definition: ts.ObjectLiteralExpression;
  handler: ts.ArrowFunction | ts.FunctionExpression;
}>;

function parse(filePath: string): ts.SourceFile {
  return ts.createSourceFile(filePath, readFileSync(filePath, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (!('name' in property) || property.name === undefined) return null;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return null;
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate) === name,
  );
  return property;
}

function findStatusMethodEntry(sourceFile: ts.SourceFile): StatusMethodEntry | undefined {
  let found: StatusMethodEntry | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length === 2 &&
      ts.isStringLiteral(node.elements[0]) &&
      node.elements[0].text === 'operation.status.v1' &&
      ts.isObjectLiteralExpression(node.elements[1])
    ) {
      const handle = objectProperty(node.elements[1], 'handle')?.initializer;
      if (handle !== undefined && (ts.isArrowFunction(handle) || ts.isFunctionExpression(handle))) {
        found = { definition: node.elements[1], handler: handle };
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function findSupervisorStatus(sourceFile: ts.SourceFile): ts.MethodDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isClassDeclaration(statement) || statement.name?.text !== 'OperationSupervisor') continue;
    return statement.members.find(
      (member): member is ts.MethodDeclaration =>
        ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === 'status',
    );
  }
  return undefined;
}

function callName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.getText();
  if (ts.isIdentifier(callee)) return callee.text;
  return callee.getText();
}

function isAssignment(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node)) {
    return (
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  }
  return (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function mutationViolation(call: ts.CallExpression): string | null {
  const callee = call.expression.getText();
  const name = callName(call);
  if (TIMER_AND_QUEUE_CALLS.has(name)) return `timer/queue call: ${name}`;
  if (MUTATING_HELPERS.has(name)) return `mutating helper call: ${name}`;
  if (callee.includes('.host.')) return `host call: ${name}`;
  if (callee.startsWith('this.#ledger.') && name !== 'get') return `ledger method other than get: ${name}`;
  return null;
}

function readOnlyViolations(
  target: ts.Node,
  allowedCalls: ReadonlySet<string>,
  requiredCalls: ReadonlySet<string>,
): string[] {
  const violations: string[] = [];
  const observedCalls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (isAssignment(node)) violations.push(`assignment/update: ${node.getText()}`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      observedCalls.add(callee);
      const mutation = mutationViolation(node);
      if (mutation !== null) violations.push(mutation);
      else if (!allowedCalls.has(callee)) violations.push(`call outside read-only allowlist: ${callee}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(target);
  for (const required of requiredCalls) {
    if (!observedCalls.has(required)) violations.push(`missing required read-only call: ${required}`);
  }
  return violations;
}

function parsedStatusResultObject(handler: StatusMethodEntry['handler']): ts.ObjectLiteralExpression | undefined {
  let result: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (result !== undefined) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === 'statusResultSchema.parse' &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      result = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(handler);
  return result;
}

describe('operation.status.v1 is structurally read-only', () => {
  it('registers the handler with observation authority and the status-specific budget', () => {
    const entry = findStatusMethodEntry(parse(PROXY_FILE));
    expect(entry, 'operation.status.v1 must exist in the proxy method map').toBeDefined();
    if (entry === undefined) return;

    expect(objectProperty(entry.definition, 'authority')?.initializer.getText()).toBe("'observation'");
    expect(objectProperty(entry.definition, 'budgetMs')?.initializer.getText()).toBe('PROXY_STATUS_RPC_TIMEOUT_MS');
  });

  it('keeps the proxy handler inside its complete read-only call allowlist', () => {
    const entry = findStatusMethodEntry(parse(PROXY_FILE));
    expect(entry, 'operation.status.v1 must exist in the proxy method map').toBeDefined();
    if (entry === undefined) return;

    expect(readOnlyViolations(entry.handler, HANDLER_ALLOWED_CALLS, HANDLER_REQUIRED_CALLS)).toEqual([]);
  });

  it('constructs and parses the complete echoed identity at the sender', () => {
    const entry = findStatusMethodEntry(parse(PROXY_FILE));
    expect(entry, 'operation.status.v1 must exist in the proxy method map').toBeDefined();
    if (entry === undefined) return;
    const result = parsedStatusResultObject(entry.handler);
    expect(result, 'the status sender must parse its own assembled result').toBeDefined();
    if (result === undefined) return;

    const proxy = objectProperty(result, 'proxy')?.initializer;
    expect(
      proxy !== undefined && ts.isObjectLiteralExpression(proxy),
      'the status sender must echo proxy identity',
    ).toBe(true);
    if (proxy === undefined || !ts.isObjectLiteralExpression(proxy)) return;
    expect(objectProperty(proxy, 'proxyInstanceId')?.initializer.getText()).toBe('identity.proxyInstanceId');
    expect(objectProperty(proxy, 'buildSetId')?.initializer.getText()).toBe('identity.buildSetId');
    expect(objectProperty(result, 'nonce')?.initializer.getText()).toBe('request.nonce');
    expect(objectProperty(result, 'operations')?.initializer.getText()).toBe('supervisor.status(request.operations)');
  });

  it('keeps OperationSupervisor.status inside its complete read-only call allowlist', () => {
    const method = findSupervisorStatus(parse(SUPERVISOR_FILE));
    expect(method, 'OperationSupervisor.status must exist').toBeDefined();
    if (method === undefined) return;

    expect(readOnlyViolations(method, SUPERVISOR_ALLOWED_CALLS, SUPERVISOR_REQUIRED_CALLS)).toEqual([]);
  });
});
