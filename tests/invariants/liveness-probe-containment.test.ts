// A liveness probe inside a timer callback must be caught there.
//
// `isProcessAlive` rethrows a question it could not ask, which is right: an unanswerable probe must never read
// as "gone" on a path whose job is proving absence. But making a shared primitive stricter changes every
// caller, and a caller inside a `setInterval`/`setTimeout` callback is the one shape where the consequence is
// not a failed operation but a **dead process** — an exception escaping a timer callback is uncaught, and Node
// terminates.
//
// This rule exists because that mistake was made three times in two commits, by the same author, each time
// while fixing the previous one: the adopted-job poller in `coordinator/services/recovery/index.ts`, then the
// KB daemon's parent watchdog. Reading for it did not work; the third instance was found only because someone
// went looking after the second.
//
// What this does NOT check, stated so the green result is not read as more than it is: whether a probe on a
// non-timer path has a catch above it somewhere, and whether the catch it finds does something sensible. Those
// need the call graph and a judgement. This checks the one shape where the cost is the whole daemon.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

/** The probes that can throw. `readProcessIncarnation` is deliberately absent: it answers `null`, never throws. */
const LIVENESS_PROBE = /^(isProcessAlive|isPidAlive|isAlive)$/;
const TIMER_SCHEDULER = /^(setInterval|setTimeout|setIntervalFn|setTimeoutFn)$/;

type Offender = Readonly<{ file: string; line: number }>;

function listSourceFiles(root: string): string[] {
  const collected: string[] = [];
  const stack: string[] = [join(REPO_ROOT, root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts')) collected.push(absolute);
    }
  }
  return collected;
}

function isTimerSchedule(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  return ts.isIdentifier(callee) && TIMER_SCHEDULER.test(callee.text);
}

function callsLivenessProbe(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  return ts.isIdentifier(callee) && LIVENESS_PROBE.test(callee.text);
}

/** Probes reachable from `body` without passing through a `try` block on the way. */
function uncaughtProbes(body: ts.Node, source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const walk = (node: ts.Node): void => {
    // A nested function is scheduled or invoked elsewhere; its own containment is judged where it is written.
    if (node !== body && (ts.isFunctionLike(node) || ts.isTryStatement(node))) return;
    if (callsLivenessProbe(node)) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  return lines;
}

describe('a liveness probe inside a timer callback is caught there', () => {
  it('no timer callback lets a probe throw past it', () => {
    const offenders: Offender[] = [];
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const canonical = relative(REPO_ROOT, filePath).replace(/\\/gu, '/');
      const source = ts.createSourceFile(canonical, readFileSync(filePath, 'utf-8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (isTimerSchedule(node)) {
          const callback = node.arguments[0];
          if (callback !== undefined && ts.isFunctionLike(callback) && callback.body !== undefined) {
            for (const line of uncaughtProbes(callback.body, source)) offenders.push({ file: canonical, line });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    // To resolve: wrap the probe in the callback's own try/catch and decide there what an unanswerable probe
    // means. It is never "gone" — that is the reading the primitive rethrows to prevent.
    expect(offenders).toEqual([]);
  });
});
