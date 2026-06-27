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

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = 'src';

// The primitive's own home — defines `safeKill` and the `gracefulKill`
// escalation that callers are supposed to use.
const PRIMITIVE_FILE = 'src/coordinator/live/process-supervision.ts';

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

/** Strips line/block comments and string literals so the scan ignores quoted
 * names and commented examples. */
function stripCommentsAndStrings(source: string): string {
  let result = source.replace(/\/\*[\s\S]*?\*\//gu, '');
  result = result.replace(/(^|\n)\s*\/\/[^\n]*/gu, '$1');
  result = result.replace(/'(?:\\.|[^'\\])*'/gu, "''");
  result = result.replace(/"(?:\\.|[^"\\])*"/gu, '""');
  result = result.replace(/`(?:\\.|\$\{[^}]*\}|[^`\\])*`/gu, '``');
  return result;
}

function callsSafeKill(source: string): boolean {
  return /(^|[^.\w$])safeKill\s*\(/u.test(stripCommentsAndStrings(source));
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
