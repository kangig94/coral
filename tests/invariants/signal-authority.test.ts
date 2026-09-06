// Signal-authority invariant — a signal aimed at a *number* must first establish that the number still names
// the process it was recorded for.
//
// A pid is not an identity: the OS recycles it. `child.kill('SIGTERM')` is therefore out of scope here, and
// deliberately so — the handle names one child, and Node refuses to signal through it once that child has been
// reaped. `process.kill(pid, sig)` has no such protection. Whatever the number meant when it was written down,
// nothing revalidates it at the moment of the call, and the failure is silent: SIGKILL to a stranger.
//
// This is not hypothetical and it is not rare. `incarnationMayAuthorizeSignal` exists because a macOS
// incarnation is wall-clock at one-second resolution and cannot carry this weight at all.
// A rule enforced by reading is a rule enforced at whatever rate people read.
//
// Recorded-pid calls are checked after exact self-pid and port-forwarding calls are removed. A safe call in
// one module must never exempt a recorded-pid sibling in the same module.
//
// Signal 0 is not a signal. `kill(pid, 0)` and `kill(-pid, 0)` are liveness probes; the worst a recycled pid
// does there is answer a question wrongly, which every caller already treats as inconclusive.
//
// One limitation, stated because a scan that hides its blind spots is worse than none: a signal delivered
// through a *helper* is attributed to the helper's file, not the caller's. `gracefulKillByPid` lives in
// `infra/process-supervision.ts`, so its callers (`live/durable-transport.ts`,
// `services/recovery/actions.ts`) are invisible here. Guarding one call inside an allowlisted file and
// deleting its entry would therefore pass while its siblings stay unguarded. Until every pid signal goes
// through one identity-bearing helper, the remaining ALLOWLIST names modules, and
// `docs/todo/durable-cli-signal-authority.md` names the behavioural paths.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { bindWithHandoff, HandoffEscalationError, type HandoffOptions } from '../../src/coordinator/handoff.js';
import type { Runtime } from '../../src/runtime/ports.js';
import type { IncumbentIdentity } from '../../src/transport/ipc/handoff.js';
import { codeTextOnly } from '../helpers/ts-code-text.js';
import { testIncarnation } from '../helpers/process-incarnation.js';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

const AUTHORITY_OWNER_FILE = 'src/infra/node-process.ts';

/**
 * Files that signal a bare pid without consulting the rule, each with what stands in for it.
 *
 * An entry is a claim, and a claim that stops being true is worse than no claim — so keep them specific
 * enough to be falsified. "It is probably fine" is not an entry.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'src/runtime/real.ts',
    // The port itself. It forwards a signal it is handed and holds no record to check one against; the
    // authority belongs to whoever produced the number.
    'the process port that forwards kill(); it has no recorded identity of its own to check',
  ],
  [
    'src/cli/run.ts',
    // `kill(process.pid, …)` — the caller's own pid, re-raising a signal on itself so the shell sees the
    // real cause of death. A process cannot be a stranger to itself.
    'signals its own pid to re-raise a handoff signal',
  ],
  [
    'src/runtime/exec-builder.ts',
    // Signals the child it is at that moment awaiting, on timeout or maxBuffer, through an injected `kill`.
    // The exposure is real but a different size: the window is the single event-loop
    // turn between the child exiting and its 'close' reaching the `resolved` guard, not a pid recovered from
    // a record written before a restart. Recorded rather than waved through, and it is the site that proved
    // the scan's own blind spot.
    'signals a child it currently holds and awaits; one-turn exit/close race, tracked with the others',
  ],
]);

const EXACT_CALL_ALLOWLIST = new Map<string, string>([
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

/**
 * Whether a file signals a pid rather than a held child.
 *
 * Read from the AST rather than a regex, because the distinction that matters is the call's *arity and
 * argument shape*: `kill(sig)` is a handle, `kill(pid, sig)` is a number, and `kill(pid, 0)` is a question.
 * Text cannot separate those without reimplementing the parser.
 *
 * Both call shapes count, and the second is why: an earlier version matched only `something.kill(pid, sig)`
 * and was blind to `kill(-child.pid, signal)` where `kill` is an *injected function* — which is exactly what
 * `runtime/exec-builder.ts` does. The scan reported a complete enumeration while missing a real signal path,
 * which is worse than not scanning, because the empty result was read as proof.
 */
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
    firstArgument !== undefined &&
    (firstArgument.getText(source) === 'process.pid' || firstArgument.getText(source) === '-process.pid')
  ) {
    return `${canonicalSrcPath(source.fileName)}:process.kill(${firstArgument.getText(source)})`;
  }
  return null;
}

function signalsABarePid(source: string, fileName: string): boolean {
  return barePidSignalCalls(source, fileName).length > 0;
}

function refusesWithoutSignalAuthority(source: string): boolean {
  return /if\s*\(\s*!\s*incarnationMayAuthorizeSignal\s*\([^)]*\)\s*\)\s*(?:\{\s*)?return\b/u.test(
    codeTextOnly(source),
  );
}

describe('a signal aimed at a pid establishes that the pid is still its recorded process', () => {
  it('no module signals a bare pid without refusing on insufficient platform authority or a written exemption', () => {
    const violations: string[] = [];
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const canonical = canonicalSrcPath(filePath);
      if (canonical === AUTHORITY_OWNER_FILE || ALLOWLIST.has(canonical)) continue;
      const source = readFileSync(filePath, 'utf-8');
      const parsed = ts.createSourceFile(canonical, source, ts.ScriptTarget.Latest, true);
      const recordedPidCalls = barePidSignalCalls(source, canonical).filter(
        (call) => !EXACT_CALL_ALLOWLIST.has(exactCallKey(call, parsed) ?? ''),
      );
      if (recordedPidCalls.length > 0 && !refusesWithoutSignalAuthority(source)) violations.push(canonical);
    }
    // To resolve: refuse when `incarnationMayAuthorizeSignal(platform)` is false and compare the recorded
    // incarnation against a fresh probe — or add an ALLOWLIST entry stating what else proves the pid.
    expect(violations.sort()).toEqual([]);
  });

  it('every exemption still signals a bare pid (stale entries are removed)', () => {
    const stale: string[] = [];
    for (const canonical of ALLOWLIST.keys()) {
      const source = readFileSync(join(REPO_ROOT, canonical), 'utf-8');
      if (!signalsABarePid(source, canonical)) stale.push(canonical);
    }
    expect(stale.sort()).toEqual([]);

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
