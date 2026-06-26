import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { KbOperationJobShell, type KbOperationJobContext } from '#src/coordinator/services/kb/shell.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import { JobStore } from '#src/jobs/store.js';
import type { JobStatus } from '#src/jobs/records.js';
import { throwIfAborted } from '#src/runtime/abort.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
function createShell(): {
  shell: KbOperationJobShell;
  abortRegistry: AbortRegistry;
  progressStore: JobStore;
} {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  const runtime = new SimulationRuntime();
  const progressStore = new JobStore('test-ns', runtime, createDefaultUpcasterRegistry(), {
    db,
    providers: permissiveProviderLookupPort,
  });
  const abortRegistry = new AbortRegistry(runtime.ids);
  const shell = new KbOperationJobShell({
    runtime,
    progressStore,
    backendNamespace: 'test-ns',
    bundleHash: 'bundle-a',
    abortRegistry,
  });
  return { shell, abortRegistry, progressStore };
}

function reindexContext(): KbOperationJobContext {
  return {
    projectRoot: '/workspace/coral',
    request: {},
    failure: {
      code: 'kb_reindex_failed',
      abortedCode: 'kb_reindex_aborted',
      operation: 'reindex',
      message: (cause) => `KB reindex failed: ${cause.message}`,
      detail: (cause) => ({ operation: 'reindex', cause }),
    },
  };
}

async function waitForTerminal(progressStore: JobStore, jobId: string): Promise<JobStatus> {
  const startedAt = Date.now();
  for (;;) {
    const status = progressStore.readStatus(jobId);
    if (status?.result !== undefined) {
      return status;
    }
    if (Date.now() - startedAt > 1000) {
      throw new Error(`No terminal recorded for ${jobId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('KbOperationJobShell', () => {
  it('runSync records started/completed envelopes and returns the body result', async () => {
    const { shell, progressStore, abortRegistry } = createShell();
    let jobId = '';

    const result = await shell.runSync('kb.reindex', reindexContext(), async (job) => {
      jobId = job.jobId;
      expect(job.signal.aborted).toBe(false);
      job.recorder.appendMessage('working');
      return {
        data: { rebuilt: true },
        terminalContent: 'Reindexed 4 KB entries.',
      };
    });

    expect(result).toEqual({ ok: true, data: { rebuilt: true } });
    expect(abortRegistry.has(jobId)).toBe(false);
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result: {
        content: 'Reindexed 4 KB entries.',
        outcome: { kind: 'completed' },
      },
    });
  });

  it('runSync normalizes thrown errors and records the failed terminal through the recorder', async () => {
    const { shell, progressStore, abortRegistry } = createShell();
    let jobId = '';

    const result = await shell.runSync('kb.reindex', reindexContext(), async (job) => {
      jobId = job.jobId;
      throw new Error('index exploded');
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'kb_reindex_failed',
      message: 'index exploded',
      detail: {
        job: jobId,
        detail: { message: 'index exploded' },
      },
    });
    expect(abortRegistry.has(jobId)).toBe(false);
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'error',
      result: {
        content: '',
        outcome: { kind: 'failed' },
      },
    });
  });

  it('runSync applies the pre-terminal abort fence before recording completion', async () => {
    const { shell, progressStore, abortRegistry } = createShell();
    let jobId = '';

    const result = await shell.runSync('kb.reindex', reindexContext(), async (job) => {
      jobId = job.jobId;
      expect(abortRegistry.abort([job.jobId])).toEqual({ aborted: [job.jobId], notFound: [] });
      return {
        data: { rebuilt: true },
        terminalContent: 'should not be committed',
      };
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'kb_reindex_aborted',
      detail: { job: jobId },
    });
    expect(abortRegistry.has(jobId)).toBe(false);
    expect(progressStore.readStatus(jobId)).toMatchObject({
      phase: 'aborted',
      result: {
        content: '',
        outcome: { kind: 'aborted', reason: 'user_abort' },
      },
    });
  });

  it('launchAsync returns a waitable job id while the body records completion in the background', async () => {
    const { shell, progressStore, abortRegistry } = createShell();

    const { jobId } = shell.launchAsync('kb.reindex', reindexContext(), async () => ({
      data: { launched: true },
      terminalContent: 'Reindexed 1 KB entry.',
    }));

    expect(jobId).toMatch(/\S/u);
    expect(abortRegistry.has(jobId)).toBe(true);

    await expect(waitForTerminal(progressStore, jobId)).resolves.toMatchObject({
      phase: 'completed',
      result: {
        content: 'Reindexed 1 KB entry.',
        outcome: { kind: 'completed' },
      },
    });
    expect(abortRegistry.has(jobId)).toBe(false);
  });

  it('launchAsync exposes active jobs until abort terminal cleanup finalizes them', async () => {
    const { shell, progressStore, abortRegistry } = createShell();

    const { jobId } = shell.launchAsync('kb.reindex', reindexContext(), async (job) => {
      await new Promise<void>((resolve) => job.signal.addEventListener('abort', () => resolve(), { once: true }));
      throwIfAborted(job.signal, 'test');
      return {
        data: { launched: true },
        terminalContent: 'unreachable',
      };
    });

    expect(abortRegistry.listActive()).toEqual([jobId]);
    expect(abortRegistry.abort([jobId])).toEqual({ aborted: [jobId], notFound: [] });

    await expect(waitForTerminal(progressStore, jobId)).resolves.toMatchObject({
      phase: 'aborted',
      result: {
        content: '',
        outcome: { kind: 'aborted', reason: 'user_abort' },
      },
    });
    expect(abortRegistry.listActive()).toEqual([]);
  });
});
