// KB daemon teardown wiring invariant.
//
// A KB daemon survived a graceful coordinator SIGTERM in production: reparented
// to init, ignoring SIGTERM, cleared only by SIGKILL. Its five stop triggers all
// funnelled into one `stop()` behind a single latch, so the first arrival ran
// the cleanup and the other four became no-ops, and that cleanup then awaited
// `kbWriteHost.dispose()` with no bound at all.
//
// The repair is four pieces of wiring, and each one is invisible from the outside
// until the day it matters:
//
//   1. `stop()` opens the terminal window, OUTSIDE the cleanup latch. The window
//      is what makes the four triggers arriving after the first into something
//      other than no-ops.
//   2. `stopAsync()` hands that window's signal to `dispose()`. Disposal already
//      threads a signal through the joins that observe one; before the repair the
//      caller passed nothing, so every one of them received `undefined`.
//   3. Pending parent requests are cancelled BEFORE the disposal await, not in a
//      `finally` after it. Cleanup can await work that is itself waiting on a
//      parent response, and a cancellation sequenced after that await can never
//      be the thing that releases it.
//   4. The coordinator disposes the supervisor when startup fails. The daemon is
//      started fire-and-forget, so a later startup step throwing can leave a child
//      already spawned, and it is the one piece that outlives the coordinator.
//
// Unit tests cover the window authority's own behaviour. They cannot see any of
// the above: every one of these could be deleted and those tests would stay
// green, because they call the authority directly. This test is that gap. It is
// deliberately structural — the behavioural version needs a process-level test
// that kills a coordinator and watches a real daemon PID disappear, which is
// recorded as open in `docs/todo/kb-daemon-independent-containment.md`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codeTextOnly } from '../helpers/ts-code-text.js';

const REPO_ROOT = join(__dirname, '..', '..');

const read = (relativePath: string): string => codeTextOnly(readFileSync(join(REPO_ROOT, relativePath), 'utf-8'));

describe('KB daemon stop wiring', () => {
  const daemonMain = read('src/kb-daemon/daemon-main.ts');

  it('opens the terminal window from stop, not from the latched cleanup', () => {
    // In `stop`, which every trigger calls — never inside `stopAsync`, which
    // returns early once the cleanup has been latched by an earlier trigger.
    const stopBody = /const stop = \(code: number\): void => \{([\s\S]*?)\n {2}\};/u.exec(daemonMain)?.[1];
    expect(stopBody, 'the stop trigger entry point must still be recognisable').toBeDefined();
    expect(stopBody).toMatch(/terminal\.open\(/u);

    const stopAsyncBody = /const stopAsync = async \([\s\S]*?\n {2}\};/u.exec(daemonMain)?.[0];
    expect(stopAsyncBody, 'the latched cleanup must still be recognisable').toBeDefined();
    expect(stopAsyncBody).not.toMatch(/terminal\.open\(/u);
  });

  it('hands the window signal to disposal instead of calling it bare', () => {
    expect(daemonMain).toMatch(/kbWriteHost\.dispose\(\s*\{\s*signal\s*\}\s*\)/u);
    expect(daemonMain, 'a bare dispose() gives every join inside it `signal: undefined`').not.toMatch(
      /kbWriteHost\.dispose\(\s*\)/u,
    );
  });

  it('cancels pending parent requests before awaiting disposal, not after it', () => {
    const cancelAt = daemonMain.indexOf('cancelPendingParentRequests(');
    const disposeAt = daemonMain.search(/await kbWriteHost\.dispose\(/u);
    expect(cancelAt, 'parent-request cancellation must still exist').toBeGreaterThan(-1);
    expect(disposeAt, 'the disposal await must still exist').toBeGreaterThan(-1);
    expect(cancelAt).toBeLessThan(disposeAt);
  });
});

describe('coordinator startup-failure cleanup', () => {
  it('disposes the KB daemon supervisor it started fire-and-forget', () => {
    const lifecycle = read('src/coordinator/lifecycle.ts');
    expect(lifecycle).toMatch(/kbDaemonSupervisor\?\.dispose\(/u);
  });
});
