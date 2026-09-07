// Every non-probe signal aimed at a number must refresh the exact target identity inside its enclosing
// signalling function. A guarded sibling cannot authorize another function in the same module.
// `child.kill(signal)` remains outside the scan because the child handle, rather than a reusable number,
// carries the target authority. Signal-zero probes carry no delivery authority.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/** Exact calls whose target identity is intrinsic to the call site rather than a recorded number. */
const EXACT_CALL_ALLOWLIST = new Map<string, string>([
  [
    'src/runtime/real.ts:process.kill(pid)',
    'the process port that forwards kill(); it has no recorded identity of its own to check',
  ],
  ['src/cli/run.ts:process.kill(process.pid)', 'signals its own pid to re-raise a handoff signal'],
  ['src/cli/commands/backend.ts:process.kill(process.pid)', 'signals its own pid to re-raise a continuation signal'],
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

function establishesSignalAuthority(source: string): boolean {
  const text = codeTextOnly(source);
  // A branded capability the wrong evidence cannot construct carries the same authority as an inline
  // guard: `verifySignalTarget` refuses unless it refreshed the exact identity, and nothing else mints one.
  if (/verifySignalTarget\s*\(/u.test(text) || /\bHandoffSignalCapability\b/u.test(text)) return true;
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
    if (scope === null || !establishesSignalAuthority(scope.getText(parsed))) {
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
    // To resolve: refuse when `incarnationMayAuthorizeSignal(platform)` is false and compare the recorded
    // incarnation against a fresh probe — or add an ALLOWLIST entry stating what else proves the pid.
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

  // A refusal guard against `incarnationMayAuthorizeSignal('linux')` is still a constant no-op, so the
  // platform argument is checked separately from the guard shape.
  it('the gated signal path refuses, and asks about the running platform rather than a constant', () => {
    for (const canonical of ['src/coordinator/live/provider-proxy/spawn-undo.ts']) {
      const raw = readFileSync(join(REPO_ROOT, canonical), 'utf-8');
      expect(
        /if\s*\(\s*!\s*incarnationMayAuthorizeSignal\s*\([^)]*\)\s*\)\s*return/u.test(codeTextOnly(raw)),
        `${canonical} must refuse, not merely ask`,
      ).toBe(true);

      const parsed = ts.createSourceFile(canonical, raw, ts.ScriptTarget.Latest, true);
      const constantArguments: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'incarnationMayAuthorizeSignal'
        ) {
          for (const argument of node.arguments) {
            if (ts.isStringLiteralLike(argument)) constantArguments.push(argument.getText(parsed));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);

      expect(constantArguments, `${canonical} must ask about the platform it is running on`).toEqual([]);
    }
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
