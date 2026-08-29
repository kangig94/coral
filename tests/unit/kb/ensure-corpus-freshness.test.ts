import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import * as rescanModule from '#src/kb/corpus/rescan/index.js';
import type { RescanCounts } from '#src/kb/corpus/projection-lifecycle.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { createKbTestDb } from '#tests/helpers/kb/runtime-test-helpers.js';

// Spec §12.3 lazy non-blocking rescan: KB read paths return immediately with
// the current index and dispatch a single shared background rebuild;
// readiness/boot/curate paths use `wait: true` to block on that rebuild.

interface RescanGate {
  release: (counts?: RescanCounts) => void;
  wasInvoked: () => boolean;
  callCount: () => number;
  receivedSignals: () => Array<AbortSignal | undefined>;
}

function installGatedRescan(): RescanGate {
  const calls: Array<{
    kb: KbRuntime;
    startState: Parameters<typeof rescanModule.performRescan>[1];
    resolve: (result: Awaited<ReturnType<typeof rescanModule.performRescan>>) => void;
  }> = [];
  const signals: Array<AbortSignal | undefined> = [];
  vi.spyOn(rescanModule, 'performRescan').mockImplementation(async (kb, startState, options) => {
    signals.push(options?.signal);
    return new Promise((resolve) => {
      calls.push({ kb, startState, resolve });
    });
  });
  return {
    release: (counts) => {
      const next = calls.shift();
      if (next === undefined) {
        throw new Error('No pending rescan to release.');
      }
      // Mark fresh at completion time, matching the real rescan commit boundary.
      next.kb.recordReindexSuccess(next.startState);
      next.resolve({
        status: 'committed',
        commitId: 'test-commit',
        counts: counts ?? emptyCounts(),
        snapshot: next.kb.captureCorpusSnapshot(),
        state: next.kb.readIndexState(),
      });
    },
    wasInvoked: () => calls.length > 0,
    callCount: () => calls.length,
    receivedSignals: () => signals,
  };
}

function emptyCounts(): RescanCounts {
  return {
    notes: 0,
    sources: 0,
    communities: 0,
    wikis: 0,
    principles: 0,
    tags: 0,
    entities: 0,
    relationships: 0,
    entityCoverage: 0,
  };
}

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

async function waitForGateInvocation(gate: RescanGate): Promise<void> {
  for (let attempt = 0; attempt < 20 && gate.callCount() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeRuntime(): KbRuntime {
  const root = mkdtempSync(join(tmpdir(), 'coral-ensure-fresh-'));
  tempRoots.push(root);
  const db = createKbTestDb(':memory:');
  openDatabases.push(db);
  return createTestKbRuntime({ markdownRoot: root, runtimeDir: root, db });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of openDatabases.splice(0)) {
    db.close();
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  // Each test installs its own gated rescan; ensure no module-level mock leaks.
});

describe('KbRuntime.ensureCorpusFreshness', () => {
  it('non-blocking read returns immediately and kicks one background rebuild', async () => {
    const gate = installGatedRescan();
    const kb = makeRuntime();

    const start = Date.now();
    const index = await kb.ensureCorpusFreshness({ wait: false });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
    expect(index).toBeDefined();
    await waitForGateInvocation(gate);
    expect(gate.wasInvoked()).toBe(true);

    gate.release();
  });

  it('promise dedup: concurrent stale reads share one rebuild', async () => {
    const gate = installGatedRescan();
    const kb = makeRuntime();

    await kb.ensureCorpusFreshness({ wait: false });
    await kb.ensureCorpusFreshness({ wait: false });
    await kb.ensureCorpusFreshness({ wait: false });
    await waitForGateInvocation(gate);

    expect(gate.callCount()).toBe(1);

    gate.release();
  });

  it('blocking readiness call awaits the in-flight rebuild', async () => {
    const gate = installGatedRescan();
    const kb = makeRuntime();

    await kb.ensureCorpusFreshness({ wait: false });
    await waitForGateInvocation(gate);
    expect(gate.callCount()).toBe(1);

    let waitResolved = false;
    const waitPromise = kb.ensureCorpusFreshness({ wait: true }).then(() => {
      waitResolved = true;
    });

    // Yield several rounds — the wait must NOT resolve until release().
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
    expect(waitResolved).toBe(false);
    expect(gate.callCount()).toBe(1);

    gate.release();
    await waitPromise;
    expect(waitResolved).toBe(true);
  });

  it('aborted signal suppresses background kicks and clears in-flight slot for next boot', async () => {
    const gate = installGatedRescan();
    const kb = makeRuntime();

    const controller = new AbortController();
    controller.abort();

    const index = await kb.ensureCorpusFreshness({ wait: false, signal: controller.signal });
    expect(index).toBeDefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(gate.callCount()).toBe(0);

    // A fresh (un-aborted) call afterwards must dispatch a rebuild — the
    // rebuildInFlight slot was never set, so the next boot proceeds normally.
    await kb.ensureCorpusFreshness({ wait: false });
    await waitForGateInvocation(gate);
    expect(gate.callCount()).toBe(1);

    gate.release();
  });

  it('blocking variant on aborted signal throws so caller does not silently see stale data', async () => {
    installGatedRescan();
    const kb = makeRuntime();
    const controller = new AbortController();
    controller.abort();

    await expect(kb.ensureCorpusFreshness({ wait: true, signal: controller.signal })).rejects.toThrow(/aborted/i);
  });

  it('5 concurrent non-blocking reads + 1 blocking readiness — only one rebuild, readiness blocks until release', async () => {
    const gate = installGatedRescan();
    const kb = makeRuntime();

    const reads: Array<Promise<unknown>> = [];
    for (let i = 0; i < 5; i += 1) {
      reads.push(kb.ensureCorpusFreshness({ wait: false }));
    }
    let readinessResolved = false;
    const readiness = kb.ensureCorpusFreshness({ wait: true }).then(() => {
      readinessResolved = true;
    });

    await Promise.all(reads);
    await Promise.resolve();

    expect(gate.callCount()).toBe(1);

    // Readiness still blocks because the rebuild has not yet released.
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
    expect(readinessResolved).toBe(false);

    gate.release();
    await readiness;
    expect(readinessResolved).toBe(true);
  });

  it('keeps a shared rebuild alive when one waiting caller aborts', async () => {
    const gate = installGatedRescan();
    const kb = makeRuntime();

    const controller = new AbortController();
    const abortedWait = kb.ensureCorpusFreshness({ wait: true, signal: controller.signal });
    let secondResolved = false;
    const secondWait = kb.ensureCorpusFreshness({ wait: true }).then(() => {
      secondResolved = true;
    });
    await waitForGateInvocation(gate);

    expect(gate.callCount()).toBe(1);
    const [received] = gate.receivedSignals();
    expect(received).toBeUndefined();
    controller.abort('test_user_abort');
    await expect(abortedWait).rejects.toThrow(/aborted/i);
    expect(secondResolved).toBe(false);

    gate.release();
    await secondWait;
    expect(secondResolved).toBe(true);
  });
});
