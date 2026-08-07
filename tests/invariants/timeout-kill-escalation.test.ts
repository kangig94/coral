// Process-kill escalation invariant — terminating a live child process must
// escalate SIGTERM→SIGKILL (via `gracefulKill`), never a bare
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
// partial copy of `reapRecordedContainment` in its role main, both missing the
// escalation's own correctness guarantees). The second describe block below
// closes that gap: it flags a module that signals a literal `'SIGTERM'` and a
// literal `'SIGKILL'` through the real `.kill()` primitive itself, outside the
// two sanctioned helpers and their shared home.

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
// predates this second check and sits in a domain this fix did not touch (the Claude appserver child
// lifecycle, the coordinator's own acquisition-time guardian undo); recorded here as known debt with its own
// reason, not silenced as a false positive. Migrating one to a sanctioned helper removes its entry.
const HAND_ROLLED_ESCALATION_ALLOWLIST = new Map<string, string>([
  [
    'src/coordinator/live/provider-proxy/spawn-undo.ts',
    // `buildGuardianSpawnUndo`'s own comment: a shorter fixed grace (`gracefulKillByPid`'s, built for a plain
    // child with nothing of its own left to do) would force-kill the guardian mid-reap and strand the very
    // containment it was just asked to hold, so it spends the full teardown-reserve budget instead.
    'deliberately not gracefulKillByPid — a plain-child grace period would force-kill the guardian mid-reap of its own containment',
  ],
  [
    'src/providers/claude/appserver/controller.ts',
    'pre-existing Claude appserver child-shutdown escalation (two call sites: shutdown() and the replacement-child path), not yet migrated to gracefulKill',
  ],
  [
    'src/providers/claude/appserver/print-controller.ts',
    'pre-existing Claude appserver child-shutdown escalation (shutdown()), not yet migrated to gracefulKill',
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

/** The literal signal `call` passes directly as one of its arguments, if any. Deliberately only a bare string
 *  literal argument, not any expression that might evaluate to one: `kill(pid, force ? 'SIGKILL' : 'SIGTERM')`
 *  is a caller choosing one signal at a time via a flag, not a hand-rolled two-step escalation, so neither
 *  branch of that ternary is "directly an argument" the way a bare literal is. */
function literalKillSignal(call: ts.CallExpression): 'SIGTERM' | 'SIGKILL' | null {
  for (const argument of call.arguments) {
    if (ts.isStringLiteral(argument) && (argument.text === 'SIGTERM' || argument.text === 'SIGKILL')) {
      return argument.text;
    }
  }
  return null;
}

/** Every literal signal a module signals through the real `.kill()` primitive, by walking its AST directly
 *  rather than scanning text — comments and unrelated strings are structurally invisible to this walk, not
 *  merely pattern-excluded from it. */
function handRolledEscalationSignals(source: string): Set<'SIGTERM' | 'SIGKILL'> {
  const sourceFile = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const signals = new Set<'SIGTERM' | 'SIGKILL'>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isKillPrimitiveCall(node)) {
      const signal = literalKillSignal(node);
      if (signal !== null) signals.add(signal);
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
