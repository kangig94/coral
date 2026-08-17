// Signal-authority invariant — a signal aimed at a *number* must first establish that the number still names
// the process it was recorded for.
//
// A pid is not an identity: the OS recycles it. `child.kill('SIGTERM')` is therefore out of scope here, and
// deliberately so — the handle names one child, and Node refuses to signal through it once that child has been
// reaped. `process.kill(pid, sig)` has no such protection. Whatever the number meant when it was written down,
// nothing revalidates it at the moment of the call, and the failure is silent: SIGKILL to a stranger.
//
// This is not hypothetical and it is not rare. `incarnationMayAuthorizeSignal` exists because a macOS
// incarnation is wall-clock at one-second resolution and cannot carry this weight at all; the rule was written
// once and, when this invariant was added, applied at two of the nine sites that needed it. Review found two
// more. The remaining four were found by this scan — which is the argument for the scan: a rule enforced by
// reading is a rule enforced at whatever rate people read.
//
// The scan is intentionally coarse — file-level, not call-level. Every file that signals a bare pid must
// either consult `incarnationMayAuthorizeSignal`, or carry an entry below saying what makes its number safe.
// Coarse is the right grain: an exemption is a claim about a subsystem's evidence, and it should be written
// down where a reader of that subsystem will meet it.
//
// Signal 0 is not a signal. `kill(pid, 0)` and `kill(-pid, 0)` are liveness probes; the worst a recycled pid
// does there is answer a question wrongly, which every caller already treats as inconclusive.
//
// One limitation, stated because a scan that hides its blind spots is worse than none: a signal delivered
// through a *helper* is attributed to the helper's file, not the caller's. `gracefulKillByPid` lives in
// `infra/process-supervision.ts`, so its three callers (`live/durable-transport.ts` twice,
// `services/recovery/actions.ts` once) are invisible here. Guarding one call inside an allowlisted file and
// deleting its entry would therefore pass while its siblings stay unguarded. Until every pid signal goes
// through one identity-bearing helper, the ALLOWLIST names modules, and
// `docs/todo/durable-cli-signal-authority.md` names the behavioural paths.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { codeTextOnly } from '../helpers/ts-code-text.js';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

// The rule's own home, and the two liveness primitives whose whole body is a signal-0 probe.
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
  ['src/cli/commands/backend.ts', 'signals its own pid to re-raise a continuation signal'],
  [
    'src/infra/process-containment.ts',
    // The known gap, deliberately open rather than hidden: closing it here breaks coordinator-local provider
    // host teardown, which has no reclaimer. Both the reasoning and the shape of the real fix are in
    // docs/todo/darwin-signal-authority.md, and this entry is what keeps that document from being the only
    // place it is recorded.
    'deliberately open on darwin — see docs/todo/darwin-signal-authority.md',
  ],
  [
    'src/coordinator/live/durable-transport.ts',
    // Signals a durable child's pid after an idle timeout measured in minutes. The identity IS recorded
    // (`durable_cli_process.v1` carries an incarnation) and is not consulted.
    'UNGUARDED, tracked in docs/todo/durable-cli-signal-authority.md',
  ],
  ['src/jobs/reconcile/registry.ts', 'UNGUARDED, tracked in docs/todo/durable-cli-signal-authority.md'],
  ['src/coordinator/services/recovery/service.ts', 'UNGUARDED, tracked in docs/todo/durable-cli-signal-authority.md'],
  [
    'src/infra/process-supervision.ts',
    'UNGUARDED (gracefulKillByPid), tracked in docs/todo/durable-cli-signal-authority.md',
  ],
  [
    'src/runtime/exec-builder.ts',
    // Signals the child it is at that moment awaiting, on timeout or maxBuffer, through an injected `kill`.
    // The exposure is real but a different size from the durable four: the window is the single event-loop
    // turn between the child exiting and its 'close' reaching the `resolved` guard, not a pid recovered from
    // a record written before a restart. Recorded rather than waved through, and it is the site that proved
    // the scan's own blind spot.
    'signals a child it currently holds and awaits; one-turn exit/close race, tracked with the others',
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
function signalsABarePid(source: string, fileName: string): boolean {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let found = false;

  const namesKill = (callee: ts.Expression): boolean =>
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'kill') ||
    (ts.isIdentifier(callee) && callee.text === 'kill');

  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && namesKill(node.expression) && node.arguments.length >= 2) {
      const signal = node.arguments[1];
      const isProbe = signal !== undefined && ts.isNumericLiteral(signal) && signal.text === '0';
      if (!isProbe) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return found;
}

function consultsSignalAuthority(source: string): boolean {
  return /(^|[^.\w$])incarnationMayAuthorizeSignal\s*\(/u.test(codeTextOnly(source));
}

describe('a signal aimed at a pid establishes that the pid is still its recorded process', () => {
  it('no module signals a bare pid without consulting the platform rule or a written exemption', () => {
    const violations: string[] = [];
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      const canonical = canonicalSrcPath(filePath);
      if (canonical === AUTHORITY_OWNER_FILE || ALLOWLIST.has(canonical)) continue;
      const source = readFileSync(filePath, 'utf-8');
      if (signalsABarePid(source, canonical) && !consultsSignalAuthority(source)) violations.push(canonical);
    }
    // To resolve: consult `incarnationMayAuthorizeSignal(platform)` before signalling and compare the recorded
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
  });

  // The scan answers "did the file consult the rule", never "did it obey the answer", and never "did it ask
  // about the platform it is actually running on". A guard-shaped statement reading
  // `incarnationMayAuthorizeSignal('linux')` satisfies the first two and is a constant `true` — the whole
  // refusal deleted, in a form that still greps as present. That mutation survived the first version of this
  // test, so the argument is checked here rather than only the shape.
  it('the two gated signal paths refuse, and ask about the running platform rather than a constant', () => {
    for (const canonical of ['src/coordinator/live/provider-proxy/spawn-undo.ts', 'src/provider-proxy/role-main.ts']) {
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
});
