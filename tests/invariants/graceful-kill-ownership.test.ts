import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const FIXTURE_ROOT = 'tests/invariants/fixtures/graceful-kill-ownership';

type GracefulKillCallSite = Readonly<{
  path: string;
  scope: string;
  subject: string;
  call: ts.CallExpression;
  boundary: ts.FunctionLikeDeclaration;
}>;

function sourceFiles(root: string): string[] {
  return readdirSync(join(REPO_ROOT, root), { withFileTypes: true }).flatMap((entry) => {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(REPO_ROOT, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function namedScope(node: ts.FunctionLikeDeclaration): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
    return node.name.getText(node.getSourceFile()).replace(/^#/u, '');
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText(node.getSourceFile());
  }
  return null;
}

function isFunctionBoundary(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function owningScope(node: ts.Node): Readonly<{ name: string; boundary: ts.FunctionLikeDeclaration }> {
  let nearestBoundary: ts.FunctionLikeDeclaration | undefined;
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (!isFunctionBoundary(current)) continue;
    const boundary = nearestBoundary ?? current;
    nearestBoundary = boundary;
    const name = namedScope(current);
    if (name !== null) return { name, boundary };
  }
  throw new Error(`${node.getSourceFile().fileName}: gracefulKill call has no owning function`);
}

function collectGracefulKillCallSites(): GracefulKillCallSite[] {
  return sourceFiles('src').flatMap((path) => {
    const source = parseSource(path);
    const calls: GracefulKillCallSite[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'gracefulKill') {
        const scope = owningScope(node);
        calls.push({
          path,
          scope: scope.name,
          subject: node.arguments[0]?.getText(source) ?? '<missing>',
          call: node,
          boundary: scope.boundary,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return calls;
  });
}

function callSiteIdentity(site: Pick<GracefulKillCallSite, 'path' | 'scope' | 'subject'>): string {
  return `${site.path} | ${site.scope} | ${site.subject}`;
}

function directDescendants(boundary: ts.FunctionLikeDeclaration): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== boundary && isFunctionBoundary(node)) return;
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(boundary);
  return nodes;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function rootIdentifier(expression: ts.Expression): string | null {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function lexicalScopes(context: ts.Node): Array<ts.FunctionLikeDeclaration | ts.SourceFile> {
  const scopes: Array<ts.FunctionLikeDeclaration | ts.SourceFile> = [];
  for (let current: ts.Node | undefined = context.parent; current !== undefined; current = current.parent) {
    if (isFunctionBoundary(current) || ts.isSourceFile(current)) scopes.push(current);
  }
  return scopes;
}

function nodesInLexicalScope(scope: ts.FunctionLikeDeclaration | ts.SourceFile): ts.Node[] {
  if (isFunctionBoundary(scope)) return directDescendants(scope);
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== scope && isFunctionBoundary(node)) {
      nodes.push(node);
      return;
    }
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return nodes;
}

function variableDeclaration(name: string, context: ts.Node): ts.VariableDeclaration | null {
  for (const scope of lexicalScopes(context)) {
    const declarations = nodesInLexicalScope(scope).filter(
      (node): node is ts.VariableDeclaration =>
        node.getStart() < context.getStart() &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer !== undefined,
    );
    const match = declarations.at(-1);
    if (match !== undefined) return match;
  }
  return null;
}

function variableInitializer(name: string, context: ts.Node): ts.Expression | null {
  return variableDeclaration(name, context)?.initializer ?? null;
}

function functionReturns(name: string, context: ts.Node): ts.Expression[] {
  const returns: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionBoundary(node) && namedScope(node) === name && node.getStart() < context.getStart()) {
      directDescendants(node).forEach((descendant) => {
        if (ts.isReturnStatement(descendant) && descendant.expression !== undefined) {
          returns.push(descendant.expression);
        }
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(context.getSourceFile());
  return returns;
}

function callsSubjectClose(node: ts.Node, subject: string): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      (current.expression.name.text === 'on' || current.expression.name.text === 'once') &&
      rootIdentifier(current.expression.expression) === subject &&
      current.arguments[0] !== undefined &&
      ts.isStringLiteral(unwrapExpression(current.arguments[0])) &&
      (unwrapExpression(current.arguments[0]) as ts.StringLiteral).text === 'close'
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function expressionJoinsSubjectClose(
  expression: ts.Expression,
  subject: string,
  context: ts.Node,
  seen = new Set<string>(),
): boolean {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return (
      rootIdentifier(current.expression) === subject &&
      (current.name.text === 'closed' || current.name.text === 'processClosePromise')
    );
  }
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return false;
    seen.add(current.text);
    const initializer = variableInitializer(current.text, context);
    return initializer !== null && expressionJoinsSubjectClose(initializer, subject, context, seen);
  }
  if (ts.isNewExpression(current) && current.expression.getText(context.getSourceFile()) === 'Promise') {
    return callsSubjectClose(current, subject);
  }
  if (!ts.isCallExpression(current)) return false;
  if (
    current.expression.getText(context.getSourceFile()) === 'waitForClose' &&
    current.arguments[0] !== undefined &&
    rootIdentifier(current.arguments[0]) === subject
  ) {
    return true;
  }
  if (
    ts.isPropertyAccessExpression(current.expression) &&
    (current.expression.name.text === 'then' ||
      current.expression.name.text === 'catch' ||
      current.expression.name.text === 'finally')
  ) {
    return expressionJoinsSubjectClose(current.expression.expression, subject, context, seen);
  }
  if (
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.expression.getText(context.getSourceFile()) === 'Promise' &&
    current.expression.name.text === 'race'
  ) {
    const candidates = current.arguments.flatMap((argument) =>
      ts.isArrayLiteralExpression(unwrapExpression(argument))
        ? [...(unwrapExpression(argument) as ts.ArrayLiteralExpression).elements]
        : [argument],
    );
    return candidates.some((candidate) => expressionJoinsSubjectClose(candidate, subject, context, seen));
  }
  return false;
}

function objectIsJoinableHold(expression: ts.ObjectLiteralExpression, subject: string, context: ts.Node): boolean {
  const properties = new Map(
    expression.properties.flatMap((property) =>
      ts.isPropertyAssignment(property) ||
      ts.isMethodDeclaration(property) ||
      ts.isShorthandPropertyAssignment(property)
        ? [[property.name.getText(context.getSourceFile()), property] as const]
        : [],
    ),
  );
  const discriminant = properties.get('kind') ?? properties.get('disposition');
  if (!discriminant || !ts.isPropertyAssignment(discriminant)) return false;
  const value = unwrapExpression(discriminant.initializer);
  const retryAfter = properties.get('retryAfter');
  const retry = properties.get('retry');
  const retryIsCallable =
    retry !== undefined &&
    (ts.isMethodDeclaration(retry) ||
      (ts.isPropertyAssignment(retry) &&
        (ts.isArrowFunction(unwrapExpression(retry.initializer)) ||
          ts.isFunctionExpression(unwrapExpression(retry.initializer)))) ||
      (ts.isShorthandPropertyAssignment(retry) &&
        (() => {
          const initializer = variableInitializer(retry.name.text, context);
          return (
            initializer !== null &&
            (ts.isArrowFunction(unwrapExpression(initializer)) ||
              ts.isFunctionExpression(unwrapExpression(initializer)))
          );
        })()));
  return (
    ts.isStringLiteral(value) &&
    (value.text === 'held' || value.text === 'holding') &&
    retryAfter !== undefined &&
    ts.isPropertyAssignment(retryAfter) &&
    expressionJoinsSubjectClose(retryAfter.initializer, subject, context) &&
    retryIsCallable
  );
}

function returnsJoinableHold(statement: ts.ReturnStatement, subject: string): boolean {
  if (statement.expression === undefined) return false;
  const expression = unwrapExpression(statement.expression);
  if (ts.isObjectLiteralExpression(expression)) return objectIsJoinableHold(expression, subject, statement);
  if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return false;
  const returns = functionReturns(expression.expression.text, statement);
  return (
    returns.length > 0 &&
    returns.every((returned) => {
      const value = unwrapExpression(returned);
      return ts.isObjectLiteralExpression(value) && objectIsJoinableHold(value, subject, statement);
    })
  );
}

function returnHasDecisiveExit(
  statement: ts.ReturnStatement,
  boundary: ts.FunctionLikeDeclaration,
  subject: string,
): boolean {
  const isString = (expression: ts.Expression, value: string): boolean => {
    const current = unwrapExpression(expression);
    return ts.isStringLiteral(current) && current.text === value;
  };
  const isSubjectProperty = (expression: ts.Expression, property: string): boolean => {
    const current = unwrapExpression(expression);
    return (
      ts.isPropertyAccessExpression(current) &&
      rootIdentifier(current.expression) === subject &&
      current.name.text === property
    );
  };
  const observesSubject = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (!ts.isCallExpression(current)) return false;
    const observer = unwrapExpression(current.expression);
    const isLivenessObserver =
      (ts.isIdentifier(observer) &&
        (observer.text === 'observeLiveness' || observer.text === 'observeProcessLiveness')) ||
      (ts.isPropertyAccessExpression(observer) && observer.name.text === 'observeLiveness');
    return isLivenessObserver && current.arguments[0] !== undefined && rootIdentifier(current.arguments[0]) === subject;
  };
  const provesSubjectAbsent = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (!ts.isBinaryExpression(current)) return false;
    if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return provesSubjectAbsent(current.left) && provesSubjectAbsent(current.right);
    }
    if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return provesSubjectAbsent(current.left) || provesSubjectAbsent(current.right);
    }
    if (current.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
    return (
      (observesSubject(current.left) && isString(current.right, 'absent')) ||
      (observesSubject(current.right) && isString(current.left, 'absent'))
    );
  };
  const provesSubjectClosed = (expression: ts.Expression): boolean => {
    const current = unwrapExpression(expression);
    if (isSubjectProperty(current, 'processClosed') || isSubjectProperty(current, 'closed')) return true;
    if (ts.isIdentifier(current)) {
      const declaration = variableDeclaration(current.text, statement);
      const scope = declaration === null ? null : lexicalScopes(declaration)[0];
      let isSetBySubjectClose = false;
      const visit = (node: ts.Node): void => {
        if (isSetBySubjectClose) return;
        if (
          !ts.isCallExpression(node) ||
          !ts.isPropertyAccessExpression(node.expression) ||
          (node.expression.name.text !== 'on' && node.expression.name.text !== 'once') ||
          rootIdentifier(node.expression.expression) !== subject ||
          node.arguments[0] === undefined ||
          !ts.isStringLiteral(unwrapExpression(node.arguments[0])) ||
          (unwrapExpression(node.arguments[0]) as ts.StringLiteral).text !== 'close' ||
          node.arguments[1] === undefined ||
          !isFunctionBoundary(unwrapExpression(node.arguments[1]))
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        isSetBySubjectClose = directDescendants(unwrapExpression(node.arguments[1]) as ts.FunctionLikeDeclaration).some(
          (descendant) =>
            ts.isBinaryExpression(descendant) &&
            descendant.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(descendant.left) &&
            descendant.left.text === current.text &&
            descendant.right.kind === ts.SyntaxKind.TrueKeyword,
        );
      };
      if (scope !== null && scope !== undefined) visit(scope);
      if (isSetBySubjectClose) return true;
    }
    if (!ts.isBinaryExpression(current)) return false;
    if (current.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return provesSubjectClosed(current.left) && provesSubjectClosed(current.right);
    }
    if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return provesSubjectClosed(current.left) || provesSubjectClosed(current.right);
    }
    if (
      current.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ((ts.isIdentifier(unwrapExpression(current.left)) &&
        (unwrapExpression(current.left) as ts.Identifier).text === 'daemonProcess' &&
        rootIdentifier(current.right) === subject) ||
        (ts.isIdentifier(unwrapExpression(current.right)) &&
          (unwrapExpression(current.right) as ts.Identifier).text === 'daemonProcess' &&
          rootIdentifier(current.left) === subject))
    ) {
      return true;
    }
    const result = isString(current.right, 'closed')
      ? unwrapExpression(current.left)
      : isString(current.left, 'closed')
        ? unwrapExpression(current.right)
        : null;
    if (result === null || !ts.isIdentifier(result)) return false;
    const initializer = variableInitializer(result.text, statement);
    return (
      initializer !== null &&
      ts.isAwaitExpression(unwrapExpression(initializer)) &&
      expressionJoinsSubjectClose((unwrapExpression(initializer) as ts.AwaitExpression).expression, subject, statement)
    );
  };

  for (
    let current: ts.Node | undefined = statement.parent;
    current !== undefined && current !== boundary;
    current = current.parent
  ) {
    if (
      !ts.isIfStatement(current) ||
      (current.thenStatement !== statement.parent && current.thenStatement !== statement)
    ) {
      continue;
    }
    if (provesSubjectAbsent(current.expression) || provesSubjectClosed(current.expression)) return true;
  }
  return false;
}

function closeJoins(site: GracefulKillCallSite, nodes: readonly ts.Node[]): ts.AwaitExpression[] {
  const subject = rootIdentifier(site.call.arguments[0]);
  if (subject === null) return [];
  return nodes.filter(
    (node): node is ts.AwaitExpression =>
      ts.isAwaitExpression(node) && expressionJoinsSubjectClose(node.expression, subject, node),
  );
}

function directStatementInBlock(node: ts.Node, block: ts.Block): ts.Statement | null {
  for (let current: ts.Node | undefined = node; current !== undefined && current !== block; current = current.parent) {
    if (current.parent === block && ts.isStatement(current)) return current;
  }
  return null;
}

function runsUnconditionallyWithin(node: ts.Node, block: ts.Block): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined && current !== block;
    current = current.parent
  ) {
    if (
      ts.isIfStatement(current) ||
      ts.isConditionalExpression(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      return false;
    }
  }
  return true;
}

function joinDominatesExit(join: ts.AwaitExpression, exit: ts.Node, boundary: ts.FunctionLikeDeclaration): boolean {
  for (
    let current: ts.Node | undefined = exit.parent;
    current !== undefined && current !== boundary;
    current = current.parent
  ) {
    if (!ts.isBlock(current)) continue;
    const joinStatement = directStatementInBlock(join, current);
    const exitStatement = directStatementInBlock(exit, current);
    if (joinStatement === null || exitStatement === null) continue;
    if (!runsUnconditionallyWithin(join, current)) return false;
    return current.statements.indexOf(joinStatement) < current.statements.indexOf(exitStatement);
  }
  return false;
}

function isWithinSameInfiniteLoop(site: GracefulKillCallSite, join: ts.AwaitExpression): boolean {
  for (
    let current: ts.Node | undefined = join.parent;
    current !== undefined && current !== site.boundary;
    current = current.parent
  ) {
    if (
      ts.isWhileStatement(current) &&
      current.expression.kind === ts.SyntaxKind.TrueKeyword &&
      site.call.getStart() >= current.getStart() &&
      site.call.getEnd() <= current.getEnd() &&
      ts.isBlock(current.statement) &&
      runsUnconditionallyWithin(join, current.statement)
    ) {
      return true;
    }
  }
  return false;
}

function identifierDeclaredWithin(name: string, boundary: ts.FunctionLikeDeclaration): boolean {
  return (
    boundary.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name) ||
    directDescendants(boundary).some(
      (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
    )
  );
}

function boundaryTypeName(boundary: ts.FunctionLikeDeclaration): string | null {
  const parent = boundary.parent;
  return ts.isVariableDeclaration(parent) && parent.type !== undefined
    ? parent.type.getText(boundary.getSourceFile())
    : null;
}

function retainingRegistrar(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  return (
    call.expression.name.text === 'on' ||
    call.expression.name.text === 'once' ||
    call.expression.name.text === 'addEventListener'
  );
}

function containsIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && current.text === name) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function handoffCallHasAcceptanceCheck(call: ts.CallExpression): boolean {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'onWrapperSpawned' ||
    !ts.isVariableDeclaration(call.parent) ||
    !ts.isIdentifier(call.parent.name)
  ) {
    return false;
  }
  const resultName = call.parent.name.text;
  const scope = lexicalScopes(call.parent)[0];
  if (scope === undefined) return false;
  return nodesInLexicalScope(scope).some((node) => {
    if (!ts.isBinaryExpression(node)) return false;
    const left = unwrapExpression(node.left);
    const right = unwrapExpression(node.right);
    return (
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
      ts.isPropertyAccessExpression(left) &&
      rootIdentifier(left.expression) === resultName &&
      left.name.text === 'kind' &&
      ts.isStringLiteral(right) &&
      right.text === 'accepted'
    );
  });
}

function propertyBoundaryHasRetainedOwner(boundary: ts.FunctionLikeDeclaration): boolean {
  if (!ts.isPropertyAssignment(boundary.parent) || !ts.isObjectLiteralExpression(boundary.parent.parent)) return false;
  let value: ts.Node = boundary.parent.parent;
  while (true) {
    const parent = value.parent;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isConditionalExpression(parent)
    ) {
      value = parent;
      continue;
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === value) &&
      parent.expression.getText(boundary.getSourceFile()) === 'Object.freeze'
    ) {
      value = parent;
      continue;
    }
    break;
  }

  const parent = value.parent;
  if (ts.isReturnStatement(parent) || (isFunctionBoundary(parent) && parent.body === value)) return true;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some((argument) => argument === value) &&
    handoffCallHasAcceptanceCheck(parent)
  ) {
    return true;
  }
  if (!ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name)) return false;
  const ownerName = parent.name.text;
  const scope = lexicalScopes(parent)[0];
  if (scope === undefined) return false;
  return nodesInLexicalScope(scope).some(
    (node) =>
      node.getStart() > parent.getStart() &&
      ts.isReturnStatement(node) &&
      node.expression !== undefined &&
      containsIdentifier(node.expression, ownerName),
  );
}

function boundaryIsRetainedCallback(site: GracefulKillCallSite): boolean {
  const boundaryParent = site.boundary.parent;
  if (ts.isPropertyAssignment(boundaryParent) && propertyBoundaryHasRetainedOwner(site.boundary)) return true;
  if (
    ts.isCallExpression(boundaryParent) &&
    retainingRegistrar(boundaryParent) &&
    boundaryParent.arguments.some((argument) => unwrapExpression(argument) === site.boundary)
  ) {
    return true;
  }

  const ownsRetryTimer = directDescendants(site.boundary).some((node) => {
    if (
      !ts.isCallExpression(node) ||
      node.getStart() >= site.call.getStart() ||
      node.expression.getText(site.call.getSourceFile()) !== 'setInterval' ||
      !ts.isBinaryExpression(node.parent) ||
      node.parent.right !== node ||
      node.parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isIdentifier(node.parent.left)
    ) {
      return false;
    }
    return !identifierDeclaredWithin(node.parent.left.text, site.boundary);
  });
  if (ownsRetryTimer) return true;

  const boundaryName = namedScope(site.boundary);
  if (boundaryName === null) return false;
  let retained = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      retainingRegistrar(node) &&
      node.arguments.some((argument) => {
        const current = unwrapExpression(argument);
        return ts.isIdentifier(current) && current.text === boundaryName;
      })
    ) {
      retained = true;
      return;
    }
    if (!retained) ts.forEachChild(node, visit);
  };
  visit(site.call.getSourceFile());
  return retained;
}

function boundaryRetainsSubject(site: GracefulKillCallSite): boolean {
  const argument = unwrapExpression(site.call.arguments[0]);
  const subject = rootIdentifier(argument);
  if (subject === null) return false;
  if (!identifierDeclaredWithin(subject, site.boundary) && boundaryIsRetainedCallback(site)) return true;
  if (
    ts.isPropertyAccessExpression(argument) &&
    argument.name.text === 'child' &&
    site.boundary.parameters.some(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === subject &&
        parameter.type?.getText(site.call.getSourceFile()) === 'ProviderServerEntry',
    )
  ) {
    return true;
  }
  return boundaryTypeName(site.boundary) === 'ProcessIncarnationProbeTerminator';
}

function subjectRetainedBeforeCall(site: GracefulKillCallSite): boolean {
  const subject = rootIdentifier(site.call.arguments[0]);
  if (subject === null) return false;
  return directDescendants(site.boundary).some((node) => {
    if (!ts.isBinaryExpression(node) || node.getStart() >= site.call.getStart()) return false;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(node.left)) return false;
    if (rootIdentifier(node.right) !== subject) return false;
    return !identifierDeclaredWithin(node.left.text, site.boundary);
  });
}

function joinDominatesBoundaryExit(join: ts.AwaitExpression, boundary: ts.FunctionLikeDeclaration): boolean {
  if (boundary.body === undefined || !ts.isBlock(boundary.body)) return false;
  const statement = directStatementInBlock(join, boundary.body);
  return (
    statement !== null &&
    runsUnconditionallyWithin(join, boundary.body) &&
    ((ts.isExpressionStatement(statement) && statement.expression === join) ||
      (ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((declaration) => declaration.initializer === join)))
  );
}

function throwBeforeJoinViolations(site: GracefulKillCallSite): string[] {
  const nodes = directDescendants(site.boundary).filter((node) => node.getStart() > site.call.getStart());
  const joins = closeJoins(site, nodes);
  return nodes
    .filter(ts.isThrowStatement)
    .filter((statement) => !joins.some((join) => joinDominatesExit(join, statement, site.boundary)))
    .map(() => `${callSiteIdentity(site)} throws before the child obligation is joined`);
}

function unownedExitViolations(site: GracefulKillCallSite): string[] {
  const nodes = directDescendants(site.boundary).filter((node) => node.getStart() > site.call.getStart());
  const subject = rootIdentifier(site.call.arguments[0]);
  if (subject === null) return [`${callSiteIdentity(site)} has no identifiable process subject`];
  const joins = closeJoins(site, nodes);
  const returns = nodes.filter(ts.isReturnStatement);
  const violations = throwBeforeJoinViolations(site);

  for (const statement of returns) {
    if (returnsJoinableHold(statement, subject) || returnHasDecisiveExit(statement, site.boundary, subject)) continue;
    if (joins.some((join) => joinDominatesExit(join, statement, site.boundary))) continue;
    violations.push(`${callSiteIdentity(site)} returns before the child obligation is joined`);
  }

  const holds = returns.some((statement) => returnsJoinableHold(statement, subject));
  const joinsImplicitExit = joins.some(
    (join) => joinDominatesBoundaryExit(join, site.boundary) || isWithinSameInfiniteLoop(site, join),
  );
  if (!holds && !joinsImplicitExit) {
    violations.push(`${callSiteIdentity(site)} has no joinable exit for unobservable liveness`);
  }
  return [...new Set(violations)];
}

function ownershipViolations(site: GracefulKillCallSite): string[] {
  const throwViolations = throwBeforeJoinViolations(site);
  if (subjectRetainedBeforeCall(site) || boundaryRetainsSubject(site)) return throwViolations;
  return unownedExitViolations(site);
}

function fixtureCallSite(name: string): GracefulKillCallSite {
  const path = `${FIXTURE_ROOT}/${name}.ts.txt`;
  const source = parseSource(path);
  let match: GracefulKillCallSite | undefined;
  const visit = (node: ts.Node): void => {
    if (match === undefined && ts.isCallExpression(node) && node.expression.getText(source) === 'gracefulKill') {
      const scope = owningScope(node);
      match = {
        path,
        scope: scope.name,
        subject: node.arguments[0]?.getText(source) ?? '<missing>',
        call: node,
        boundary: scope.boundary,
      };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (match === undefined) throw new Error(`${path}: expected gracefulKill call`);
  return match;
}

describe('gracefulKill call sites retain a joinable process owner', () => {
  it('keeps every kill boundary pending, disposition-bearing, or backed by retained state', () => {
    const violations = collectGracefulKillCallSites().flatMap(ownershipViolations);
    if (violations.length > 0) {
      throw new Error(`Unowned gracefulKill boundaries:\n${violations.join('\n')}`);
    }
    expect(violations).toEqual([]);
  });

  it.each([
    'throw',
    'void-return',
    'successful-return',
    'sync-void-return',
    'call-argument-callback',
    'unretained-object-property',
    'fake-hold-call',
    'unrelated-close-await',
    'conditional-close-join',
    'wrong-subject-absence',
  ])('rejects the %s negative control', (fixture) => {
    expect(ownershipViolations(fixtureCallSite(fixture))).not.toHaveLength(0);
  });

  it.each(['held-disposition', 'close-join'])('accepts the %s positive control', (fixture) => {
    expect(ownershipViolations(fixtureCallSite(fixture))).toEqual([]);
  });
});
