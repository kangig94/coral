// Process-kill escalation invariant — terminating a live child or recorded
// process group must escalate SIGTERM→SIGKILL via `gracefulKill` or
// `reapRecordedContainment`, respectively, never a bare
// `safeKill(child, 'SIGTERM')` that leaks a wedged child when it ignores the
// term signal. The rule itself is the BLOCKING "Timeout kills use SIGTERM then
// SIGKILL after delay" check in `.claude/rules/validation.md`; this test is its
// enforcement so the rule cannot silently regress (it did once: three bare
// SIGTERM kills shipped in the KB daemon supervisor before review caught them).
//
// `safeKill` is the low-level primitive. Its only legitimate homes are:
//   - `process-supervision.ts`, which defines it and builds the SIGTERM→SIGKILL
//     escalation (`gracefulKill`) on top of it.
//   - explicit ALLOWLIST entries below: kill sites that are NOT terminating a
//     live, responsive-but-unresponsive child (e.g. cleanup of a process that
//     failed to spawn), where escalation is meaningless.
// Every other child termination MUST go through `gracefulKill`.
//
// A bare-`safeKill` scan alone is blind to a module that never mentions
// `safeKill` at all and instead reimplements the SIGTERM→SIGKILL escalation
// from scratch against the raw `.kill()` primitive (it happened twice: a
// verbatim copy of `gracefulKill` in the provider proxy's role spawner, and a
// second implementation of `reapRecordedContainment`'s discipline in its role
// main). The second describe block below closes that gap: it flags a module
// that signals a literal `'SIGTERM'` and a literal `'SIGKILL'` through the real
// `.kill()` primitive itself, including when a local call routes those literals
// through one or more parameters, outside the two sanctioned helpers and their
// shared home.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { codeTextOnly } from '../helpers/ts-code-text.js';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

// The primitive's own home — defines `safeKill` and the `gracefulKill`
// escalation that callers are supposed to use.
const PRIMITIVE_FILE = 'src/infra/process-supervision.ts';
// The other sanctioned escalation helper's own home — defines
// `reapRecordedContainment`'s SIGTERM→SIGKILL sequence.
const CONTAINMENT_HELPER_FILE = 'src/infra/process-containment.ts';
// A negative primitive scan cannot prove an owner still reaps its containment:
// deleting teardown entirely would also make that scan pass. Keep both owners
// explicit so adding one cannot silently narrow the escalation guarantee.
const RECORDED_CONTAINMENT_OWNER_FILES = [
  'src/provider-proxy/enforcement.ts',
  'src/coordinator/live/provider-hosts/drain.ts',
] as const;

// File-level allowlist: call sites permitted to use the bare primitive, each
// with the reason escalation does not apply. Adding a new entry is a conscious
// decision that must carry a justification.
const ALLOWLIST = new Map<string, string>([
  [
    'src/coordinator/live/kb-daemon-supervisor.ts',
    // The single bare call is the spawn-error catch: the child either failed to
    // spawn or lacks piped stdio, so it is not a live process awaiting graceful
    // shutdown. The timeout/stop paths in this file use `gracefulKill`.
    'spawn-error cleanup of a process that never reached a live, ready state',
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
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        collected.push(absolute);
      }
    }
  }
  return collected;
}

function canonicalSrcPath(filePath: string): string {
  return relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function callsSafeKill(source: string): boolean {
  return /(^|[^.\w$])safeKill\s*\(/u.test(codeTextOnly(source));
}

function callsReapRecordedContainment(source: string): boolean {
  return /(^|[^.\w$])reapRecordedContainment\s*\(/u.test(codeTextOnly(source));
}

describe('process kills escalate SIGTERM→SIGKILL', () => {
  it('no module calls the bare safeKill primitive outside its home or the documented allowlist', () => {
    const violations: string[] = [];
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const canonical = canonicalSrcPath(filePath);
      if (canonical === PRIMITIVE_FILE || ALLOWLIST.has(canonical)) continue;
      if (callsSafeKill(readFileSync(filePath, 'utf-8'))) {
        violations.push(canonical);
      }
    }
    // To resolve a violation: use `gracefulKill(child, runtime)` (SIGTERM then
    // SIGKILL after a grace period). Only add to ALLOWLIST if the child is not a
    // live process awaiting graceful shutdown, with the reason recorded there.
    expect(violations).toEqual([]);
  });

  it('every allowlisted file still calls safeKill (stale exemptions are removed)', () => {
    const stale: string[] = [];
    for (const canonical of ALLOWLIST.keys()) {
      const source = readFileSync(join(REPO_ROOT, canonical), 'utf-8');
      if (!callsSafeKill(source)) {
        stale.push(canonical);
      }
    }
    expect(stale).toEqual([]);
  });
});

// Unlike `ALLOWLIST` above (sites where escalation is meaningless), every entry here IS a genuine, working
// SIGTERM→SIGKILL escalation — just not one routed through `gracefulKill`/`reapRecordedContainment`. Each
// is recorded as known debt or a target-shape exception with its own reason, not silenced as a false positive.
// Migrating one to a sanctioned helper removes its entry.
const HAND_ROLLED_ESCALATION_ALLOWLIST = new Map<string, string>([
  [
    'src/coordinator/live/provider-proxy/spawn-undo.ts',
    // `buildGuardianSpawnUndo`'s own comment: a shorter fixed grace (`gracefulKillByPid`'s, built for a plain
    // child with nothing of its own left to do) would force-kill the guardian mid-reap and strand the very
    // containment it was just asked to hold, so it spends the full teardown-reserve budget instead.
    'deliberately not gracefulKillByPid — a plain-child grace period would force-kill the guardian mid-reap of its own containment',
  ],
  [
    'src/coordinator/handoff.ts',
    // Handoff targets a separately discovered incumbent, not a child or recorded containment. Each signal
    // requires a fresh pid/start-time check and its own capability, policy, cooldown, and audit handling.
    'verified incumbent handoff escalation has no child handle or recorded containment and revalidates policy and identity before each audited signal',
  ],
  [
    'src/providers/claude/appserver/controller.ts',
    'pre-existing Claude appserver child-shutdown escalation (two call sites: shutdown() and the replacement-child path), not yet migrated to gracefulKill',
  ],
  [
    'src/providers/claude/appserver/print-controller.ts',
    'pre-existing Claude appserver child-shutdown escalation (shutdown()), not yet migrated to gracefulKill',
  ],
  [
    'src/provider-proxy/role-main.ts',
    // Guardian-construction unwind must synchronously confirm both a detached proxy group and an ordinary,
    // non-detached reaper pid absent on its monotonic clock. `reapRecordedContainment` cannot represent the
    // latter without falsely claiming it is a process-group leader; `gracefulKill` does not confirm absence.
    'guardian-construction unwind confirms an ordinary non-detached child pid that neither sanctioned helper can represent without losing absence confirmation',
  ],
]);

/** Whether `call`'s callee is the real kill primitive (`child.kill(`, `process.kill(`, a bare `kill(`) rather
 *  than the sanctioned `safeKill`/`gracefulKill` wrapper — the same "callee is exactly `kill`" distinction the
 *  bare-primitive scan above draws via its own regex, restated here as an AST check because this scan needs to
 *  read the call's *argument*, which a regex over `codeTextOnly`'s output cannot: `codeTextOnly` blanks every
 *  string literal specifically so an identifier scan cannot trip on one, but that also erases the literal
 *  `'SIGTERM'`/`'SIGKILL'` text this check exists to find — the same blanking would erase it whether it came
 *  from a comment or from a genuine call argument, so no regex over that output could tell the two apart. An
 *  AST call-argument check has no such blind spot: a comment is not a node, and a string used for anything
 *  other than a real argument of a real `kill(` call is not this call's argument. */
function isKillPrimitiveCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : null;
  return name === 'kill';
}

/** Deliberately resolves only bare signal literals. A ternary chooses one signal at a time; it does not prove
 *  that the module contains a two-step escalation. Local parameter flow is resolved separately below. */
type KillSignal = 'SIGTERM' | 'SIGKILL';
type LocalFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function literalSignal(expression: ts.Expression | undefined): KillSignal | null {
  if (
    expression &&
    ts.isStringLiteral(expression) &&
    (expression.text === 'SIGTERM' || expression.text === 'SIGKILL')
  ) {
    return expression.text;
  }
  return null;
}

function signalArgument(call: ts.CallExpression): ts.Expression | undefined {
  return call.arguments[call.arguments.length - 1];
}

function localFunctions(sourceFile: ts.SourceFile): Map<string, LocalFunction> {
  const functions = new Map<string, LocalFunction>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.body !== undefined) {
      functions.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
      ) {
        functions.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return functions;
}

function forEachCallIn(localFunction: LocalFunction, inspect: (call: ts.CallExpression) => void): void {
  const body = localFunction.body;
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) inspect(node);
    ts.forEachChild(node, visit);
  };
  if (body !== undefined) visit(body);
}

function localCalleeName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

function parameterIndex(localFunction: LocalFunction, expression: ts.Expression): number | null {
  if (!ts.isIdentifier(expression)) return null;
  const index = localFunction.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === expression.text,
  );
  return index === -1 ? null : index;
}

type ParameterFlow = Readonly<{
  callerName: string;
  callerParameter: number;
  calleeParameter: number;
}>;

/** Parameter positions that eventually reach the signal argument of a real kill primitive. The worklist
 *  follows local wrapper calls too, so `outer(signal) -> inner(signal) -> process.kill(pid, signal)` remains
 *  visible regardless of how many local functions separate the literal from `.kill()`. Function bodies are
 *  walked once; propagation thereafter visits only the parameter-flow edges. */
function signalParametersByFunction(
  functions: ReadonlyMap<string, LocalFunction>,
): ReadonlyMap<string, ReadonlySet<number>> {
  const signalParameters = new Map([...functions.keys()].map((name) => [name, new Set<number>()]));
  const callersByCallee = new Map<string, ParameterFlow[]>();
  const pending: Array<Readonly<{ functionName: string; parameter: number }>> = [];

  const markSignalParameter = (functionName: string, parameter: number): void => {
    const parameters = signalParameters.get(functionName);
    if (parameters === undefined || parameters.has(parameter)) return;
    parameters.add(parameter);
    pending.push({ functionName, parameter });
  };

  for (const [callerName, localFunction] of functions) {
    forEachCallIn(localFunction, (call) => {
      if (isKillPrimitiveCall(call)) {
        const argument = signalArgument(call);
        if (argument === undefined) return;
        const index = parameterIndex(localFunction, argument);
        if (index !== null) markSignalParameter(callerName, index);
        return;
      }

      const calleeName = localCalleeName(call);
      if (calleeName === null || !functions.has(calleeName)) return;
      const flows = callersByCallee.get(calleeName) ?? [];
      for (const [calleeParameter, argument] of call.arguments.entries()) {
        const callerParameter = parameterIndex(localFunction, argument);
        if (callerParameter !== null) {
          flows.push({ callerName, callerParameter, calleeParameter });
        }
      }
      callersByCallee.set(calleeName, flows);
    });
  }

  while (pending.length > 0) {
    const signalParameter = pending.pop();
    if (signalParameter === undefined) continue;
    for (const flow of callersByCallee.get(signalParameter.functionName) ?? []) {
      if (flow.calleeParameter === signalParameter.parameter) {
        markSignalParameter(flow.callerName, flow.callerParameter);
      }
    }
  }
  return signalParameters;
}

/** Every literal signal a module routes to the real `.kill()` primitive, by walking its AST and following
 *  local parameter flow. Comments and unrelated strings are structurally invisible to this walk. */
function handRolledEscalationSignals(source: string): Set<KillSignal> {
  const sourceFile = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = localFunctions(sourceFile);
  const signalParameters = signalParametersByFunction(functions);
  const signals = new Set<KillSignal>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const directSignal = isKillPrimitiveCall(node) ? literalSignal(signalArgument(node)) : null;
      if (directSignal !== null) signals.add(directSignal);

      const calleeName = localCalleeName(node);
      if (calleeName !== null) {
        for (const index of signalParameters.get(calleeName) ?? []) {
          const signal = literalSignal(node.arguments[index]);
          if (signal !== null) signals.add(signal);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return signals;
}

function hasHandRolledEscalation(source: string): boolean {
  const signals = handRolledEscalationSignals(source);
  return signals.has('SIGTERM') && signals.has('SIGKILL');
}

describe('process kills do not hand-roll a SIGTERM→SIGKILL escalation outside the sanctioned helpers', () => {
  it('both recorded-containment owners reap their recorded groups through reapRecordedContainment without an allowlist exemption', () => {
    const ownersWithoutRecordedContainmentReaping = RECORDED_CONTAINMENT_OWNER_FILES.filter(
      (canonical) => !callsReapRecordedContainment(readFileSync(join(REPO_ROOT, canonical), 'utf-8')),
    );
    const exemptedOwners = RECORDED_CONTAINMENT_OWNER_FILES.filter(
      (canonical) => ALLOWLIST.has(canonical) || HAND_ROLLED_ESCALATION_ALLOWLIST.has(canonical),
    );

    expect({ ownersWithoutRecordedContainmentReaping, exemptedOwners }).toEqual({
      ownersWithoutRecordedContainmentReaping: [],
      exemptedOwners: [],
    });
  });

  it('detects a parameter-routed local escalation mutation', () => {
    const mutation = `
      function signal(pid: number, value: NodeJS.Signals): void {
        process.kill(pid, value);
      }
      function forward(pid: number, value: NodeJS.Signals): void {
        signal(pid, value);
      }
      function reap(pid: number): void {
        forward(pid, 'SIGTERM');
        forward(pid, 'SIGKILL');
      }
    `;

    expect(handRolledEscalationSignals(mutation)).toEqual(new Set<KillSignal>(['SIGTERM', 'SIGKILL']));
  });

  it('no module combines a literal SIGTERM kill with a literal SIGKILL kill outside gracefulKill, reapRecordedContainment, or the documented allowlist', () => {
    const violations: string[] = [];
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const canonical = canonicalSrcPath(filePath);
      if (
        canonical === PRIMITIVE_FILE ||
        canonical === CONTAINMENT_HELPER_FILE ||
        HAND_ROLLED_ESCALATION_ALLOWLIST.has(canonical)
      ) {
        continue;
      }
      if (hasHandRolledEscalation(readFileSync(filePath, 'utf-8'))) {
        violations.push(canonical);
      }
    }
    // To resolve a violation: route the escalation through `gracefulKill(child, runtime)` or
    // `reapRecordedContainment(...)`. Only add to HAND_ROLLED_ESCALATION_ALLOWLIST for a documented, deliberate
    // reason a sanctioned helper cannot be used yet — never merely to silence this.
    expect(violations).toEqual([]);
  });

  it('every hand-rolled-escalation allowlist entry still combines both signals (stale exemptions are removed)', () => {
    const stale: string[] = [];
    for (const canonical of HAND_ROLLED_ESCALATION_ALLOWLIST.keys()) {
      const source = readFileSync(join(REPO_ROOT, canonical), 'utf-8');
      if (!hasHandRolledEscalation(source)) {
        stale.push(canonical);
      }
    }
    expect(stale).toEqual([]);
  });
});
