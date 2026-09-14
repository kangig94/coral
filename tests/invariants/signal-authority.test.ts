// Every non-probe signal to a numeric target must refresh its exact identity in the enclosing signalling
// function, or derive the number from a branded live-child authority after refusing a collected child.
// Authority cannot cross function boundaries. Child-handle signalling carries its own authority, while
// signal-zero probes carry no delivery authority.

import { readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { bindWithHandoff, HandoffEscalationError, type HandoffOptions } from '../../src/coordinator/handoff.js';
import type { Runtime } from '../../src/runtime/ports.js';
import type { IncumbentIdentity } from '../../src/transport/ipc/handoff.js';
import { codeTextOnly } from '../helpers/ts-code-text.js';
import { isFunctionScope } from '../helpers/ts-function-scope.js';
import { testIncarnation } from '../helpers/process-incarnation.js';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

const AUTHORITY_OWNER_FILE = 'src/infra/node-process.ts';

const EXACT_CALL_ALLOWLIST = new Map<string, string>([
  [
    'src/runtime/real.ts:process.kill(pid)',
    'the process port that forwards kill(); it has no recorded identity of its own to check',
  ],
  ['src/cli/run.ts:process.kill(process.pid)', 'signals its own pid to re-raise a handoff signal'],
  [
    'src/runtime/durable-cli-wrapper.ts:process.kill(-process.pid)',
    'signals the process group led by its own live process',
  ],
]);

function listSourceFiles(root: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [join(REPO_ROOT, root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(absolute);
    }
  }
  return collected;
}

function canonicalSrcPath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replace(/\\/gu, '/');
}

/** The scan must distinguish handle calls, numeric delivery calls, and signal-zero probes from the AST. */
function barePidSignalCalls(source: string, fileName: string): readonly ts.CallExpression[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: ts.CallExpression[] = [];

  const namesKill = (callee: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'kill') ||
    (ts.isIdentifier(callee) && callee.text === 'kill');

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && namesKill(node.expression) && node.arguments.length >= 2) {
      const signal = node.arguments[1];
      const isProbe = signal !== undefined && ts.isNumericLiteral(signal) && signal.text === '0';
      if (!isProbe) found.push(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return found;
}

function exactCallKey(call: ts.CallExpression, source: ts.SourceFile): string | null {
  const firstArgument = call.arguments[0];
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.expression.getText(source) === 'process' &&
    call.expression.name.text === 'kill' &&
    firstArgument !== undefined
  ) {
    return `${canonicalSrcPath(source.fileName)}:process.kill(${firstArgument.getText(source)})`;
  }
  return null;
}

function enclosingSignallingFunction(call: ts.CallExpression): ts.FunctionLikeDeclaration | null {
  let scope: ts.Node | undefined = call;
  while (scope !== undefined && !isFunctionScope(scope)) scope = scope.parent;
  return scope !== undefined && isFunctionScope(scope) ? scope : null;
}

function signallingFunctionName(scope: ts.FunctionLikeDeclaration, source: ts.SourceFile): string {
  if ('name' in scope && scope.name !== undefined) return scope.name.getText(source);
  const parent = scope.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) return parent.name.getText(source);
  return '<anonymous-signalling-function>';
}

type LiveChildAuthoritySource = Readonly<{
  name: string;
  declaredAt: number;
  mayBeUndefined: boolean;
}>;

type LiveChildAuthorityImports = Readonly<{
  mintNames: ReadonlySet<string>;
  typeNames: ReadonlySet<string>;
}>;

function importsLiveChildAuthorityFromCanonicalModule(source: ts.SourceFile): LiveChildAuthorityImports {
  const mintNames = new Set<string>();
  const typeNames = new Set<string>();
  const root = REPO_ROOT.replace(/\\/gu, '/');
  const sourceName = source.fileName.replace(/\\/gu, '/');
  const canonicalSourceName = sourceName.startsWith(`${root}/`) ? sourceName.slice(root.length + 1) : sourceName;

  if (canonicalSourceName === 'src/infra/process-supervision.ts') {
    mintNames.add('liveChildAuthority');
    typeNames.add('LiveChildAuthority');
  }

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.importClause?.namedBindings === undefined ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const canonicalModule =
      specifier === '#src/infra/process-supervision.js' ||
      (specifier.startsWith('.') &&
        posix.normalize(posix.join(posix.dirname(canonicalSourceName), specifier)) ===
          'src/infra/process-supervision.js');
    if (!canonicalModule) continue;

    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      if (importedName === 'liveChildAuthority') mintNames.add(element.name.text);
      if (importedName === 'LiveChildAuthority') typeNames.add(element.name.text);
    }
  }
  return { mintNames, typeNames };
}

function typeUsesImportedLiveChildAuthority(type: ts.TypeNode, importedNames: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && importedNames.has(node.typeName.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(type);
  return found;
}

function unwrappedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function dominatingStatements(call: ts.CallExpression, scope: ts.FunctionLikeDeclaration): readonly ts.Statement[] {
  const statements: ts.Statement[] = [];
  let current: ts.Node = call;
  while (current !== scope && current.parent !== undefined) {
    const parent = current.parent;
    if (ts.isBlock(parent)) {
      const containingStatement = parent.statements.find(
        (statement) => statement.pos <= current.pos && statement.end >= current.end,
      );
      if (containingStatement !== undefined) {
        const index = parent.statements.indexOf(containingStatement);
        statements.push(...parent.statements.slice(0, index));
      }
    }
    current = parent;
  }
  return statements.sort((left, right) => left.pos - right.pos);
}

function liveChildAuthoritySources(
  scope: ts.FunctionLikeDeclaration,
  statements: readonly ts.Statement[],
  imports: LiveChildAuthorityImports,
): readonly LiveChildAuthoritySource[] {
  const sources: LiveChildAuthoritySource[] = [];
  for (const parameter of scope.parameters) {
    if (
      ts.isIdentifier(parameter.name) &&
      parameter.type !== undefined &&
      typeUsesImportedLiveChildAuthority(parameter.type, imports.typeNames)
    ) {
      sources.push({ name: parameter.name.text, declaredAt: parameter.pos, mayBeUndefined: false });
    }
  }
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        !ts.isIdentifier(declaration.name) ||
        initializer === undefined ||
        !ts.isCallExpression(initializer) ||
        !ts.isIdentifier(initializer.expression) ||
        !imports.mintNames.has(initializer.expression.text)
      ) {
        continue;
      }
      sources.push({ name: declaration.name.text, declaredAt: declaration.pos, mayBeUndefined: true });
    }
  }
  return sources;
}

function callsHasExited(expression: ts.Expression, authorityName: string): boolean {
  const candidate = unwrappedExpression(expression);
  return (
    ts.isCallExpression(candidate) &&
    candidate.arguments.length === 0 &&
    ts.isPropertyAccessExpression(candidate.expression) &&
    ts.isIdentifier(candidate.expression.expression) &&
    candidate.expression.expression.text === authorityName &&
    candidate.expression.name.text === 'hasExited'
  );
}

function checksUndefined(expression: ts.Expression, authorityName: string): boolean {
  const candidate = unwrappedExpression(expression);
  if (!ts.isBinaryExpression(candidate)) return false;
  if (
    candidate.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    candidate.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
  ) {
    return false;
  }
  const isAuthority = (operand: ts.Expression): boolean => {
    const unwrapped = unwrappedExpression(operand);
    return ts.isIdentifier(unwrapped) && unwrapped.text === authorityName;
  };
  const isMissing = (operand: ts.Expression): boolean => {
    const unwrapped = unwrappedExpression(operand);
    return (
      (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined') || unwrapped.kind === ts.SyntaxKind.NullKeyword
    );
  };
  return (
    (isAuthority(candidate.left) && isMissing(candidate.right)) ||
    (isMissing(candidate.left) && isAuthority(candidate.right))
  );
}

function refusesCollectedChild(condition: ts.Expression, authority: LiveChildAuthoritySource): boolean {
  const candidate = unwrappedExpression(condition);
  if (!authority.mayBeUndefined) return callsHasExited(candidate, authority.name);
  if (!ts.isBinaryExpression(candidate) || candidate.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false;
  return (
    (checksUndefined(candidate.left, authority.name) && callsHasExited(candidate.right, authority.name)) ||
    (callsHasExited(candidate.left, authority.name) && checksUndefined(candidate.right, authority.name))
  );
}

function statementReturns(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement)) return true;
  if (!ts.isBlock(statement)) return false;
  const lastStatement = statement.statements.at(-1);
  return lastStatement !== undefined && ts.isReturnStatement(lastStatement);
}

function signalTargetsAuthority(call: ts.CallExpression, authorityName: string): boolean {
  const firstArgument = call.arguments[0];
  if (firstArgument === undefined) return false;
  let target = unwrappedExpression(firstArgument);
  if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.MinusToken) {
    target = unwrappedExpression(target.operand);
  }
  return (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === authorityName &&
    target.name.text === 'pid'
  );
}

function liveChildAuthorityGuardsSignal(
  scope: ts.FunctionLikeDeclaration,
  call: ts.CallExpression,
  source: ts.SourceFile,
): boolean {
  const statements = dominatingStatements(call, scope);
  const imports = importsLiveChildAuthorityFromCanonicalModule(source);
  for (const authority of liveChildAuthoritySources(scope, statements, imports)) {
    if (!signalTargetsAuthority(call, authority.name)) continue;
    const guard = statements.at(-1);
    const guarded =
      guard !== undefined &&
      ts.isIfStatement(guard) &&
      guard.pos > authority.declaredAt &&
      statementReturns(guard.thenStatement) &&
      refusesCollectedChild(guard.expression, authority);
    if (guarded) return true;
  }
  return false;
}

function establishesSignalAuthority(
  scope: ts.FunctionLikeDeclaration,
  call: ts.CallExpression,
  source: ts.SourceFile,
): boolean {
  const text = codeTextOnly(scope.getText(source));
  // Only exact identity evidence may authorize signalling through a branded capability or inline guard.
  if (/verifySignalTarget\s*\(/u.test(text) || /\bHandoffSignalCapability\b/u.test(text)) return true;
  if (liveChildAuthorityGuardsSignal(scope, call, source)) return true;
  // The refusal must end the `if` it opens: a tail that could run past `{`, `}` or `;` would be satisfied
  // by any later brace in the scanned text, which is how a module-wide scan read a guard that was not there.
  const refusesInsufficientPlatformAuthority =
    /if\s*\([\s\S]*?!\s*(?:incarnationMayAuthorizeSignal|identityMayAuthorizeSignal)\s*\([^)]*\)[^{};]*?\)\s*(?:\{|return\b)/u.test(
      text,
    );
  const refreshesExactIdentity =
    /readProcessIncarnation\s*\(/u.test(text) ||
    /readIncarnation\s*\(/u.test(text) ||
    /observeRecordedTarget\s*\(/u.test(text);
  return refusesInsufficientPlatformAuthority && refreshesExactIdentity;
}

function unguardedSignallingFunctions(source: string, fileName: string): readonly string[] {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations = new Set<string>();
  for (const call of barePidSignalCalls(source, fileName)) {
    if (EXACT_CALL_ALLOWLIST.has(exactCallKey(call, parsed) ?? '')) continue;
    const scope = enclosingSignallingFunction(call);
    if (scope === null || !establishesSignalAuthority(scope, call, parsed)) {
      violations.add(scope === null ? '<module-scope>' : signallingFunctionName(scope, parsed));
    }
  }
  return [...violations];
}

describe('a signal aimed at a pid establishes that the pid is still its recorded process', () => {
  it('no module signals a bare pid without refusing on insufficient platform authority or a written exemption', () => {
    const violations: string[] = [];
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const canonical = canonicalSrcPath(filePath);
      if (canonical === AUTHORITY_OWNER_FILE) continue;
      const source = readFileSync(filePath, 'utf-8');
      for (const scope of unguardedSignallingFunctions(source, canonical)) violations.push(`${canonical}::${scope}`);
    }
    // Numeric signal authority requires a fresh matching incarnation or an explicit allowlist proof.
    expect(violations.sort()).toEqual([]);
  });

  it('every exemption still signals a bare pid (stale entries are removed)', () => {
    const staleCalls: string[] = [];
    for (const key of EXACT_CALL_ALLOWLIST.keys()) {
      const separator = key.indexOf(':');
      const canonical = key.slice(0, separator);
      const source = readFileSync(join(REPO_ROOT, canonical), 'utf-8');
      const parsed = ts.createSourceFile(canonical, source, ts.ScriptTarget.Latest, true);
      const keys = barePidSignalCalls(source, canonical).map((call) => exactCallKey(call, parsed));
      if (!keys.includes(key)) staleCalls.push(key);
    }
    expect(staleCalls.sort()).toEqual([]);
  });

  it('does not let a guarded sibling hide an unguarded signalling function', () => {
    const fixture = `
      function guarded(runtime: Runtime, pid: number, incarnation: ProcessIncarnation, platform: NodeJS.Platform) {
        if (!incarnationMayAuthorizeSignal(platform)) return;
        if (runtime.process.readProcessIncarnation(pid, platform) !== incarnation) return;
        runtime.process.kill(pid, 'SIGTERM');
      }
      function unguarded(runtime: Runtime, pid: number) {
        runtime.process.kill(pid, 'SIGKILL');
      }
    `;

    expect(unguardedSignallingFunctions(fixture, 'negative-control.ts')).toEqual(['unguarded']);
  });

  it('rejects a platform guard that never refreshes the recorded identity', () => {
    const fixture = `
      function staleAuthority(runtime: Runtime, pid: number, platform: NodeJS.Platform) {
        if (!incarnationMayAuthorizeSignal(platform)) return;
        runtime.process.kill(pid, 'SIGTERM');
      }
    `;

    expect(unguardedSignallingFunctions(fixture, 'negative-control.ts')).toEqual(['staleAuthority']);
  });

  it('accepts a branded live-child authority only when its collection guard dominates its pid signal', () => {
    const fixture = `
      import { liveChildAuthority } from './infra/process-supervision.js';
      import { type LiveChildAuthority as ChildAuthority } from '#src/infra/process-supervision.js';

      function guarded(child: ChildProcessLike, kill: ProcessPort['kill']) {
        const authority = liveChildAuthority(child);
        if (authority === undefined || authority.hasExited()) return;
        kill(-authority.pid, 'SIGTERM');
      }
      function guardedParameter(authority: ChildAuthority, kill: ProcessPort['kill']) {
        if (authority.hasExited()) return;
        kill(-authority.pid, 'SIGKILL');
      }
    `;

    expect(unguardedSignallingFunctions(fixture, 'src/positive-control.ts')).toEqual([]);
  });

  it('rejects a brand that does not synchronously guard its own pid and an unbranded predicate', () => {
    const fixture = `
      import { liveChildAuthority, type LiveChildAuthority } from './infra/process-supervision.js';

      function unguardedBrand(child: ChildProcessLike, kill: ProcessPort['kill']) {
        const authority = liveChildAuthority(child);
        if (authority === undefined) return;
        kill(-authority.pid, 'SIGTERM');
      }
      async function staleAcrossAwait(authority: LiveChildAuthority, kill: ProcessPort['kill']) {
        if (authority.hasExited()) return;
        await Promise.resolve();
        kill(-authority.pid, 'SIGTERM');
      }
      function wrongSubject(authority: LiveChildAuthority, pid: number, kill: ProcessPort['kill']) {
        if (authority.hasExited()) return;
        kill(pid, 'SIGTERM');
      }
      function unbranded(pid: number, kill: ProcessPort['kill']) {
        const authority = { pid, hasExited: () => false };
        if (authority.hasExited()) return;
        kill(-authority.pid, 'SIGKILL');
      }
    `;

    expect(unguardedSignallingFunctions(fixture, 'src/negative-control.ts')).toEqual([
      'unguardedBrand',
      'staleAcrossAwait',
      'wrongSubject',
      'unbranded',
    ]);
  });

  it('rejects local functions and types that counterfeit live-child authority names', () => {
    const fixture = `
      function liveChildAuthority(child: ChildProcessLike) {
        return { pid: child.pid, hasExited: () => false };
      }
      type LiveChildAuthority = Readonly<{ pid: number; hasExited(): boolean }>;

      function counterfeitMint(child: ChildProcessLike, kill: ProcessPort['kill']) {
        const authority = liveChildAuthority(child);
        if (authority === undefined || authority.hasExited()) return;
        kill(-authority.pid, 'SIGTERM');
      }
      function counterfeitType(authority: LiveChildAuthority, kill: ProcessPort['kill']) {
        if (authority.hasExited()) return;
        kill(-authority.pid, 'SIGKILL');
      }
    `;

    expect(unguardedSignallingFunctions(fixture, 'src/counterfeit-control.ts')).toEqual([
      'counterfeitMint',
      'counterfeitType',
    ]);
  });

  it('the backend recorded-role signal has platform authority and a fresh matching incarnation', () => {
    const canonical = 'src/cli/commands/backend.ts';
    const raw = readFileSync(join(REPO_ROOT, canonical), 'utf-8');
    const parsed = ts.createSourceFile(canonical, raw, ts.ScriptTarget.Latest, true);
    const recordedPidCalls = barePidSignalCalls(raw, canonical).filter(
      (call) => !EXACT_CALL_ALLOWLIST.has(exactCallKey(call, parsed) ?? ''),
    );

    expect(recordedPidCalls).toHaveLength(1);
    const call = recordedPidCalls[0];
    if (call === undefined) throw new Error('Expected the provider-role signal call');
    let scope: ts.Node = call;
    while (scope.parent !== undefined && !ts.isFunctionLike(scope)) scope = scope.parent;
    const guardedSource = codeTextOnly(scope.getText(parsed));

    expect(guardedSource).toMatch(
      /if\s*\(\s*!\s*incarnationMayAuthorizeSignal\s*\(\s*platform\s*\)\s*\)\s*(?:\{\s*)?return\b/u,
    );
    expect(guardedSource).toMatch(
      /observedIncarnation\s*=\s*runtime\.process\.readProcessIncarnation\s*\(\s*roleIdentity\.pid\s*,\s*platform\s*\)/u,
    );
    expect(guardedSource).toMatch(/observedIncarnation\s*!==\s*roleIdentity\.incarnation/u);
  });

  // A recovered numeric path must refuse before entering containment when its running platform cannot bind
  // a signal to the recorded incarnation. Branded own-child cleanup is a separate authority path.
  it('the recovered proxy signal path terminates on insufficient running-platform authority', () => {
    const canonical = 'src/coordinator/live/provider-proxy/spawn-undo.ts';
    const raw = readFileSync(join(REPO_ROOT, canonical), 'utf-8');
    const parsed = ts.createSourceFile(canonical, raw, ts.ScriptTarget.Latest, true);
    const recoveredCalls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'reapRecordedContainment' &&
        node.arguments[0]?.getText(parsed) === 'retainedProxyIdentity'
      ) {
        recoveredCalls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);

    expect(recoveredCalls).toHaveLength(1);
    const recoveredCall = recoveredCalls[0];
    if (recoveredCall === undefined) throw new Error('Expected the recovered proxy containment call');

    let callStatement: ts.Statement | undefined;
    let branchBlock: ts.Block | undefined;
    let current: ts.Node = recoveredCall;
    while (current.parent !== undefined) {
      if (ts.isStatement(current) && ts.isBlock(current.parent)) {
        callStatement = current;
        branchBlock = current.parent;
        break;
      }
      current = current.parent;
    }
    const recoveredBranch = branchBlock?.parent;
    if (
      branchBlock === undefined ||
      callStatement === undefined ||
      recoveredBranch === undefined ||
      !ts.isIfStatement(recoveredBranch)
    ) {
      throw new Error('Expected recovered proxy delivery inside its identity branch');
    }
    expect(recoveredBranch.thenStatement).toBe(branchBlock);
    expect(codeTextOnly(recoveredBranch.expression.getText(parsed))).toMatch(/^retainedProxyIdentity\s*!==\s*null$/u);

    const callIndex = branchBlock.statements.indexOf(callStatement);
    const refusal = branchBlock.statements[callIndex - 1];
    expect(refusal && ts.isIfStatement(refusal)).toBe(true);
    if (refusal === undefined || !ts.isIfStatement(refusal)) {
      throw new Error('Expected an immediate platform refusal before recovered proxy delivery');
    }
    expect(codeTextOnly(refusal.expression.getText(parsed))).toMatch(
      /^!\s*incarnationMayAuthorizeSignal\s*\(\s*platform\s*\)$/u,
    );
    const refusalTail = ts.isBlock(refusal.thenStatement)
      ? refusal.thenStatement.statements.at(-1)
      : refusal.thenStatement;
    expect(
      refusalTail !== undefined && (ts.isReturnStatement(refusalTail) || ts.isThrowStatement(refusalTail)),
      `${canonical} must terminate the recovered path when platform authority is insufficient`,
    ).toBe(true);

    const environment = recoveredCall.arguments[3];
    expect(environment && ts.isObjectLiteralExpression(environment)).toBe(true);
    if (environment === undefined || !ts.isObjectLiteralExpression(environment)) {
      throw new Error('Expected the recovered proxy containment environment');
    }
    const passesThrough = (name: string): boolean =>
      environment.properties.some(
        (property) => ts.isShorthandPropertyAssignment(property) && property.name.text === name,
      );
    expect(passesThrough('platform')).toBe(true);
    expect(passesThrough('readProcessIncarnation')).toBe(true);
  });

  it.each([
    ['SIGTERM', 'gone'],
    ['SIGTERM', 'alive'],
    ['SIGTERM', 'unverifiable'],
    ['SIGKILL', 'gone'],
    ['SIGKILL', 'alive'],
    ['SIGKILL', 'unverifiable'],
  ] as const)(
    'does not complete a bind after accepted %s until its target is gone (%s)',
    async (signal, targetStatus) => {
      const incumbent: IncumbentIdentity = {
        pid: 91_001,
        incarnation: testIncarnation(91_001_000),
        source: 'discovery',
        instanceId: 'signal-settlement-invariant',
        token: 'token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
      };
      const acceptedSignals: NodeJS.Signals[] = [];
      let now = 0;
      let socketBound = false;
      const runtime: Pick<Runtime, 'time' | 'process' | 'env'> = {
        time: {
          now: () => now,
          monotonicNow: () => BigInt(now),
          sleep: async (ms) => {
            now += ms;
          },
        } as Runtime['time'],
        process: {
          kill: (_pid: number, acceptedSignal: NodeJS.Signals | 0) => {
            if (acceptedSignal !== 0) acceptedSignals.push(acceptedSignal);
            return true;
          },
          readProcessIncarnation: () =>
            socketBound && targetStatus === 'gone' ? null : (incumbent.incarnation ?? null),
          observeLiveness: () => {
            if (!socketBound) return 'alive';
            if (targetStatus === 'gone') return 'absent';
            return targetStatus === 'alive' ? 'alive' : 'unknown';
          },
        } as unknown as Runtime['process'],
        env: { platform: () => 'linux' } as unknown as Runtime['env'],
      };
      const options: HandoffOptions = {
        socketPath: '/tmp/coral-signal-settlement-invariant.sock',
        desired: { version: 'invariant', bundleHash: 'invariant', flavor: 'prod', namespace: 'invariant' },
        bindAttempt: async () => {
          if (acceptedSignals.includes(signal)) {
            socketBound = true;
            return { kind: 'bound' };
          }
          return { kind: 'incumbent', reason: 'signal-settlement-invariant' };
        },
        runStartupRecovery: async () => [],
        runtime,
        readVerifiedIncumbentFromDiscovery: () => incumbent,
        totalBudgetMs: 0,
      };

      const outcome = await bindWithHandoff(options).catch((error: unknown) => error);

      expect(acceptedSignals).toContain(signal);
      if (targetStatus === 'gone') {
        expect(outcome).toMatchObject({ acquiredViaHandoff: true });
      } else {
        expect(outcome).toBeInstanceOf(HandoffEscalationError);
        expect(String((outcome as Error).message)).toContain(signal);
        expect(String((outcome as Error).message)).toContain(`pid=${incumbent.pid}`);
      }
    },
  );
});
