import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import * as rescanModule from '#src/kb/corpus/rescan/index.js';
import type { RescanCounts } from '#src/kb/corpus/projection-lifecycle.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

// Spec §12.3 lazy non-blocking rescan: KB read paths return immediately with
// the current index and dispatch a single shared background rebuild;
// readiness/boot/curate paths use `wait: true` to block on that rebuild.

interface RescanGate {
  release: (counts?: RescanCounts) => void;
  invoked: Promise<void>;
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
  let markInvoked!: () => void;
  const invoked = new Promise<void>((resolve) => {
    markInvoked = resolve;
  });
  vi.spyOn(rescanModule, 'performRescan').mockImplementation(async (kb, startState, options) => {
    signals.push(options?.signal);
    return new Promise((resolve) => {
      calls.push({ kb, startState, resolve });
      markInvoked();
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
    invoked,
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

function makeRuntime(): KbRuntime {
  const root = mkdtempSync(join(tmpdir(), 'coral-ensure-fresh-'));
  tempRoots.push(root);
  const db = openKbTestStoreDb(':memory:');
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

describe('KbRuntime.ensureCorpusFreshness', () => {
  it('keeps a shared rebuild alive when one waiting caller aborts', async () => {
    const gate = installGatedRescan();
    const kb = makeRuntime();

    const controller = new AbortController();
    const abortedWait = kb.ensureCorpusFreshness({ wait: true, signal: controller.signal });
    let secondResolved = false;
    const secondWait = kb.ensureCorpusFreshness({ wait: true }).then(() => {
      secondResolved = true;
    });
    await gate.invoked;

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
