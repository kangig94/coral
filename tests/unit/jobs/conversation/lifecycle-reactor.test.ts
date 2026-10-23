import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  createRetentionWorkRetryPlan,
  isLifecycleRetentionAdmitted,
} from '#src/jobs/conversation/lifecycle-reactor.js';
import {
  publishConversationRestore,
  restoreStagePath,
  verifyConversationRestore,
} from '#src/jobs/conversation/provider-artifact-archive.js';
import { RecoveryContainment, canonicalRecoveryRevision } from '#src/recovery/containment.js';
import { eventRevisionFields } from '#src/recovery/row-revision-fields.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { createRecoverySourceRegistry } from '#src/recovery/source-registry.js';
import {
  executionHarness,
  executionInput,
  EXECUTION_JOB_ID,
  OTHER_EXECUTION_JOB_ID,
  requestedExecution,
} from '#tests/helpers/job-executions.js';
import { conversationRetentionHarness } from '#tests/helpers/conversation-retention.js';

const harnesses: ReturnType<typeof conversationRetentionHarness>[] = [];
function harness(options: Parameters<typeof conversationRetentionHarness>[0] = {}) {
  const h = conversationRetentionHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses) await h.close();
  harnesses.length = 0;
  vi.restoreAllMocks();
});

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

async function seed(h: ReturnType<typeof harness>, jobId = EXECUTION_JOB_ID) {
  h.start({ jobId });
  const handle = `/tmp/provider/${jobId}.jsonl`;
  await h.recordArtifact(handle, jobId);
  h.accept(jobId);
  const action = await h.request(jobId);
  return { handle, action, address: { jobId, execution: 1 } };
}

function continuation(h: ReturnType<typeof harness>) {
  const row = h.db
    .prepare<
      [],
      { continuation_key: string }
    >("SELECT continuation_key FROM recovery_quarantine WHERE boundary_id = 'job-conversation-retention' ORDER BY subject_key LIMIT 1")
    .get();
  return row === undefined ? null : z.record(z.unknown()).parse(JSON.parse(row.continuation_key));
}

function retentionEvents(h: ReturnType<typeof harness>) {
  return h.events().filter((event) => event.type.startsWith('job.retention.discard.'));
}

async function finish(h: ReturnType<typeof harness>, jobId = EXECUTION_JOB_ID) {
  await h.finisher.finish({ jobId, execution: h.read(jobId).execution });
}

describe('job conversation lifecycle reactor', () => {
  it('observes lifetime cancellation and settles recovery before the store closes', async () => {
    const entered = latch();
    const release = latch();
    const h = harness({
      discardArtifacts: async () => {
        entered.release();
        await release.promise;
        return { kind: 'discarded' };
      },
    });
    const { action, address } = await seed(h);
    const settlement = h.reactor.settleRetention(address, action);
    const rejected = expect(settlement).rejects.toThrow();
    await entered.promise;
    let disposed = false;
    const disposal = h.reactor.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release.release();
    await rejected;
    await disposal;
    expect(disposed).toBe(true);
    expect(h.db.prepare('SELECT 1 AS open').get()).toEqual({ open: 1 });
  });

  it('archives provider artifacts into the job export before deleting native logs', async () => {
    let archiveAtDiscard: unknown;
    const h = harness({
      discardArtifacts: async (input) => {
        archiveAtDiscard = JSON.parse(input.runtime.storage.readFileSync(h.manifestPath(), 'utf-8'));
        for (const handle of input.handles) input.runtime.storage.unlinkSync(handle);
        return { kind: 'discarded' };
      },
    });
    const { handle } = await seed(h);
    await finish(h);
    expect(archiveAtDiscard).toMatchObject({
      jobId: EXECUTION_JOB_ID,
      execution: 1,
      artifacts: [expect.objectContaining({ status: 'archived' })],
    });
    expect(h.runtime.storage.existsSync(handle)).toBe(false);
    expect(h.read()).toMatchObject({ finishing: false, open: false });
    expect(retentionEvents(h).map((event) => event.type)).toEqual([
      'job.retention.discard.requested',
      'job.retention.discard.completed',
    ]);
  });

  it.each(['same directory', 'different directory', 'expired archive'])(
    'cleans a failed prior restore stage before a later discard with %s',
    async (destination) => {
      const h = harness();
      const handle = '/home/user/.codex/sessions/2026/10/22/rollout-thread.jsonl';
      h.start();
      await h.recordArtifact(handle);
      h.accept();
      await finish(h);

      h.append(requestedExecution(2));
      await h.recordArtifact(handle, EXECUTION_JOB_ID, null);
      const verification = await verifyConversationRestore({
        runtime: h.runtime,
        conversation: h.read(),
        nativeHandle: handle,
        minimumExecution: 1,
      });
      expect(verification.kind).toBe('verified');
      const stage = restoreStagePath(handle, EXECUTION_JOB_ID, 2);
      const unlink = h.runtime.storage.unlinkSync.bind(h.runtime.storage);
      const denied = vi.spyOn(h.runtime.storage, 'unlinkSync').mockImplementation((path) => {
        if (path === stage && h.runtime.storage.existsSync(stage))
          throw Object.assign(new Error('restore stage unlink denied'), { code: 'EACCES' });
        unlink(path);
      });
      expect(
        await publishConversationRestore({ runtime: h.runtime, jobId: EXECUTION_JOB_ID, execution: 2, verification }),
      ).toMatchObject({ kind: 'unrestorable', reason: 'publication_failed' });
      expect(h.runtime.storage.readFileSync(stage, 'utf-8')).toBe('native artifact\n');
      expect(h.runtime.storage.readFileSync(handle, 'utf-8')).toBe('native artifact\n');
      h.accept();
      await finish(h);
      expect(h.read()).toMatchObject({ execution: 2, open: false, finishing: false });
      expect(h.read().retentionDiscard.attempts.at(-1)).toMatchObject({
        execution: 2,
        status: 'failed',
        reason: expect.stringContaining('restore stage unlink denied'),
      });
      expect(h.providerEffects).toHaveLength(1);

      denied.mockRestore();
      if (destination === 'expired archive') h.runtime.storage.rmSync(dirname(h.manifestPath()), { recursive: true });
      h.restart();
      h.append(requestedExecution(3));
      const nextHandle = destination === 'same directory' ? handle : '/tmp/provider/next-native.jsonl';
      await h.recordArtifact(nextHandle);
      h.accept();
      await finish(h);

      expect(h.read()).toMatchObject({ execution: 3, open: false, finishing: false });
      expect(h.read().retentionDiscard.attempts.at(-1)).toMatchObject({ execution: 3, status: 'completed' });
      expect(JSON.parse(h.runtime.storage.readFileSync(h.manifestPath(), 'utf-8'))).toMatchObject({ execution: 3 });
      expect(h.runtime.storage.existsSync(nextHandle)).toBe(false);
      expect(h.runtime.storage.existsSync(stage)).toBe(false);
    },
  );

  it.each(['unlink denied', 'directory durability unknown'])(
    'keeps native artifacts when prior-stage cleanup has %s',
    async (failure) => {
      const h = harness();
      const { handle } = await seed(h);
      await finish(h);
      h.append(requestedExecution(2));
      await h.recordArtifact(handle);
      const stage = restoreStagePath(handle, EXECUTION_JOB_ID, 2);
      h.runtime.storage.linkSync(handle, stage);
      if (failure === 'unlink denied') {
        const unlink = h.runtime.storage.unlinkSync.bind(h.runtime.storage);
        vi.spyOn(h.runtime.storage, 'unlinkSync').mockImplementation((path) => {
          if (path === stage) throw Object.assign(new Error('stage access unknown'), { code: 'EACCES' });
          unlink(path);
        });
      } else {
        const sync = h.runtime.storage.syncDirectoryDurableSync.bind(h.runtime.storage);
        vi.spyOn(h.runtime.storage, 'syncDirectoryDurableSync').mockImplementation((path) =>
          path === dirname(handle) ? false : sync(path),
        );
      }
      h.accept();
      await finish(h);
      expect(h.read().retentionDiscard.attempts.at(-1)).toMatchObject({ execution: 2, status: 'failed' });

      h.append(requestedExecution(3));
      h.accept();
      await finish(h);

      expect(h.read()).toMatchObject({ execution: 3, open: false, finishing: false });
      expect(h.read().retentionDiscard.attempts.at(-1)).toMatchObject({
        execution: 3,
        status: 'failed',
        reason: expect.stringContaining('Restore stage cleanup failed'),
      });
      expect(h.runtime.storage.readFileSync(handle, 'utf-8')).toBe('native artifact\n');
      expect(h.providerEffects).toHaveLength(1);
    },
  );

  it('keeps ownership of an unlinked prior stage until its directory sync recovers', async () => {
    const h = harness();
    const { handle } = await seed(h);
    await finish(h);
    h.append(requestedExecution(2));
    await h.recordArtifact(handle);
    const stage = restoreStagePath(handle, EXECUTION_JOB_ID, 2);
    h.runtime.storage.linkSync(handle, stage);
    const sync = h.runtime.storage.syncDirectoryDurableSync.bind(h.runtime.storage);
    const uncertain = vi
      .spyOn(h.runtime.storage, 'syncDirectoryDurableSync')
      .mockImplementation((path) => (path === dirname(handle) ? false : sync(path)));
    h.accept();
    await finish(h);
    expect(h.read().retentionDiscard.attempts.at(-1)).toMatchObject({ execution: 2, status: 'failed' });
    expect(h.runtime.storage.existsSync(stage)).toBe(false);

    h.restart();
    h.append(requestedExecution(3));
    const nextHandle = '/tmp/next-provider/native.jsonl';
    await h.recordArtifact(nextHandle);
    h.accept();
    await finish(h);
    expect(h.read().retentionDiscard.attempts.at(-1)).toMatchObject({ execution: 3, status: 'failed' });
    expect(h.runtime.storage.readFileSync(nextHandle, 'utf-8')).toBe('native artifact\n');
    expect(h.providerEffects).toHaveLength(1);

    uncertain.mockRestore();
    h.append(requestedExecution(4));
    h.accept();
    await finish(h);
    expect(h.read()).toMatchObject({ execution: 4, open: false, finishing: false });
    expect(h.read().retentionDiscard.attempts.at(-1)).toMatchObject({ execution: 4, status: 'completed' });
    expect(h.runtime.storage.existsSync(nextHandle)).toBe(false);
  });

  it('keeps artifacts owned by the finishing execution until it releases the conversation', async () => {
    const h = harness();
    const { handle } = await seed(h);
    expect(() => h.append(requestedExecution(2))).toThrowError(
      expect.objectContaining({ code: 'job_execution_order_violation' }),
    );
    expect(h.runtime.storage.existsSync(handle)).toBe(true);
    expect(h.providerEffects).toEqual([]);
    await finish(h);
    h.append(requestedExecution(2));
    expect(h.read()).toMatchObject({ jobId: EXECUTION_JOB_ID, execution: 2, open: true, finishing: false });
  });

  it('rejects replacement ownership after the discard request commits', async () => {
    const h = harness();
    const { handle } = await seed(h);
    expect(() => h.append(requestedExecution(2))).toThrow();
    expect(h.runtime.storage.existsSync(handle)).toBe(true);
    await finish(h);
    expect(h.providerEffects).toHaveLength(1);
  });

  it('enforces once when acceptance and completion observations arrive out of order', async () => {
    const h = harness({ autoObserve: false });
    await seed(h);
    const accepted = h.batches.find((batch) => batch.some((event) => event.type === 'job.execution.outcome.accepted'));
    const requested = h.batches.find((batch) =>
      batch.some((event) => event.type === 'job.retention.discard.requested'),
    );
    if (accepted === undefined || requested === undefined) throw new Error('Expected durable lifecycle events.');
    h.reactor.admitRetention();
    h.reactor.observe(requested);
    h.reactor.observe(accepted);
    await h.reactor.waitForIdle();
    await finish(h);
    h.reactor.observe(requested);
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toHaveLength(1);
    expect(h.read().open).toBe(false);
  });

  it('contains a rejected event-triggered observation and allows a later recovery pass', async () => {
    const h = harness();
    await seed(h);
    const settle = vi
      .spyOn(h.reactor, 'settleRetention')
      .mockRejectedValueOnce(new Error('fixture recovery rejection'));
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    expect(h.logs.join('')).toContain('fixture recovery rejection');
    expect(h.providerEffects).toEqual([]);
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    expect(settle).toHaveBeenCalledTimes(2);
    expect(h.providerEffects).toHaveLength(1);
  });

  it('reports startup subjects through the retention source counter', async () => {
    const h = harness();
    await seed(h);
    await seed(h, OTHER_EXECUTION_JOB_ID);
    const record = vi.fn();
    await h.reactor.scanStartup(h.lifetime.signal, { record });
    expect(record).toHaveBeenCalledExactlyOnceWith('job-conversation-retention', { subjects: 2 });
    expect(h.providerEffects).toEqual([]);
  });

  it('startup discovers existing durable requests and admission backfills them', async () => {
    const h = harness();
    await seed(h);
    h.restart();
    await h.reactor.scanStartup(h.lifetime.signal);
    expect(h.providerEffects).toEqual([]);
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    await finish(h);
    expect(h.providerEffects).toHaveLength(1);
    expect(h.read().open).toBe(false);
  });

  it.each([-100, 100, 300])(
    'preserves live execution ownership across a %s ms wall-clock adjustment until finishing closes',
    async (clockAdjustmentMs) => {
      const h = harness();
      h.reactor.admitRetention();
      h.start();
      const handle = '/tmp/provider/live-execution-clock.jsonl';
      await h.recordArtifact(handle);
      const live = h.read();
      const now = h.runtime.time.now.bind(h.runtime.time);
      vi.spyOn(h.runtime.time, 'now').mockImplementation(() => now() + clockAdjustmentMs);
      await h.reactor.scanStartup(h.lifetime.signal);
      h.runtime.time.tick(200);
      await h.reactor.waitForIdle();
      expect(h.read()).toEqual(live);
      expect(h.providerEffects).toEqual([]);
      expect(h.runtime.storage.existsSync(handle)).toBe(true);

      h.accept();
      await h.reactor.waitForIdle();
      expect(h.read()).toMatchObject({
        jobId: live.jobId,
        execution: live.execution,
        binding: live.binding,
        artifactHandles: live.artifactHandles,
        open: true,
        finishing: true,
      });
      expect(h.providerEffects).toEqual([]);
      expect(() => h.append(requestedExecution(2))).toThrow();

      await h.request();
      await h.reactor.waitForIdle();
      await finish(h);
      expect(h.read()).toMatchObject({ jobId: live.jobId, execution: 1, open: false, finishing: false });
      expect(h.providerEffects.map((effect) => effect.handles)).toEqual([[handle]]);
    },
  );

  it('continues on the next ordinal after retention closes without a continuation lease timer', async () => {
    const h = harness();
    await seed(h);
    await finish(h);
    h.append(requestedExecution(2));
    await h.recordArtifact('/tmp/provider/second-execution.jsonl');
    h.accept();
    await h.request();
    await finish(h);
    expect(h.providerEffects).toHaveLength(2);
    expect(h.read()).toMatchObject({ execution: 2, open: false });
    expect(h.read().retentionDiscard.attempts.map((attempt) => attempt.execution)).toEqual([1, 2]);
  });

  it('discovers startup work without effects and settles after idempotent admission', async () => {
    const h = harness();
    await seed(h);
    await h.reactor.scanStartup(h.lifetime.signal);
    expect(h.providerEffects).toEqual([]);
    h.reactor.admitRetention();
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toHaveLength(1);
    await finish(h);
    expect(retentionEvents(h)).toHaveLength(2);
  });

  it('re-derives deferred requests from the journal on admission', async () => {
    const h = harness({ autoObserve: false });
    await seed(h);
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toEqual([]);
    h.restart().admitRetention();
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toHaveLength(1);
    expect(continuation(h)).toMatchObject({ kind: 'completed' });
  });

  it('runs an admitted pass when admission follows the startup scan', async () => {
    const h = harness();
    await seed(h);
    await h.reactor.scanStartup(h.lifetime.signal);
    queueMicrotask(() => h.reactor.admitRetention());
    await Promise.resolve();
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toHaveLength(1);
  });

  it('keeps deferred retention free of effects while time advances', async () => {
    const h = harness();
    const { handle } = await seed(h);
    h.runtime.time.tick(60_000);
    await h.reactor.scanStartup(h.lifetime.signal);
    expect(h.runtime.storage.existsSync(handle)).toBe(true);
    expect(h.providerEffects).toEqual([]);
    expect(continuation(h)).toBeNull();
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toHaveLength(1);
  });

  it('refuses direct retry plans without a registered reactor even for absent subjects', () => {
    const h = executionHarness();
    try {
      expect(() =>
        createRetentionWorkRetryPlan(
          h.db,
          { key: 'absent', revision: { kind: 'fingerprint', value: 'revision' } },
          new AbortController().signal,
        ),
      ).toThrow();
    } finally {
      h.db.close();
    }
  });

  it('refuses direct retry plans before admission even for absent subjects', async () => {
    const h = harness();
    const subject = { key: 'absent', revision: { kind: 'fingerprint' as const, value: 'revision' } };
    expect(isLifecycleRetentionAdmitted(h.db)).toBe(false);
    expect(() => createRetentionWorkRetryPlan(h.db, subject, h.lifetime.signal)).toThrow();
    await h.reactor.scanStartup(h.lifetime.signal);
    expect(() => createRetentionWorkRetryPlan(h.db, subject, h.lifetime.signal)).toThrow('not admitted');
    h.reactor.admitRetention();
    const plan = createRetentionWorkRetryPlan(h.db, subject, h.lifetime.signal);
    expect(plan.source.boundary).toBe('job-conversation-retention');
  });

  it('preserves an exact retention quarantine until admitted retry proves absence', async () => {
    const h = harness();
    const quarantine = new RecoveryQuarantineStore(h.db, h.runtime.time);
    const subject = { key: 'missing', revision: { kind: 'fingerprint' as const, value: 'revision' } };
    quarantine.upsert({
      boundary: 'job-conversation-retention',
      subject,
      state: 'active',
      stage: 'settle',
      errorMessage: 'previous failure',
      detail: 'retention retry retained',
    });
    await h.reactor.scanStartup(h.lifetime.signal);
    expect(() => createRetentionWorkRetryPlan(h.db, subject, h.lifetime.signal)).toThrow('not admitted');
    expect(quarantine.read('job-conversation-retention', subject.key)).not.toBeNull();
    h.reactor.admitRetention();
    const plan = createRetentionWorkRetryPlan(h.db, subject, h.lifetime.signal);
    const retry = { subject, owner: 'test-owner', token: 'test-token' };
    expect(quarantine.claimRetry({ boundary: 'job-conversation-retention', subject, retry })).toBe(true);
    const report = await RecoveryContainment.each(plan.source, {
      ...plan.policy,
      signal: h.lifetime.signal,
      quarantine,
      retry,
    });
    expect(report.advanced).toBe(1);
    expect(quarantine.read('job-conversation-retention', subject.key)).toBeNull();
  });

  it.each(['failure', 'abort'] as const)(
    'propagates discovery %s at startup without count evidence or a retry timer',
    async (mode) => {
      const h = harness({ autoObserve: false });
      await seed(h);
      const abort = new AbortController();
      const failure = new Error('composition scan failed');
      const record = vi.fn();
      const timers = vi.spyOn(h.runtime.time, 'setTimeout');
      if (mode === 'abort') abort.abort();
      else
        vi.spyOn(h.db, 'prepare').mockImplementationOnce(() => {
          throw failure;
        });

      const scan = h.reactor.scanStartup(abort.signal, { record });
      if (mode === 'abort') await expect(scan).rejects.toMatchObject({ name: 'AbortError' });
      else await expect(scan).rejects.toBe(failure);
      expect(record).not.toHaveBeenCalled();
      expect(timers).not.toHaveBeenCalled();
      expect(h.providerEffects).toEqual([]);
      expect(h.logs).toEqual([]);
      expect(retentionEvents(h)).toHaveLength(1);
    },
  );

  it('retries a rejected admission pass without losing its durable request', async () => {
    const h = harness();
    await seed(h);
    vi.spyOn(h.reactor, 'settleRetention').mockRejectedValueOnce(new Error('fixture failed pass'));
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    expect(retentionEvents(h)).toHaveLength(1);
    expect(h.read().finishing).toBe(true);
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    await finish(h);
    expect(h.read().finishing).toBe(false);
  });

  it('coalesces concurrent settlement callers under the same execution owner', async () => {
    const entered = latch();
    const release = latch();
    const h = harness({
      discardArtifacts: async (input) => {
        entered.release();
        await release.promise;
        for (const handle of input.handles) input.runtime.storage.unlinkSync(handle);
        return { kind: 'discarded' };
      },
    });
    const { action, address } = await seed(h);
    const first = h.reactor.settleRetention(address, action);
    const joined = h.reactor.settleRetention(address, action);
    expect(joined).toBe(first);
    await entered.promise;
    release.release();
    await expect(first).resolves.toEqual({ kind: 'completed', outcome: 'discarded' });
    expect(h.providerEffects).toHaveLength(1);
  });

  it('logs a rejected background attempt once and recovers from the original action', async () => {
    const h = harness();
    const { action, address } = await seed(h);
    const settle = vi.spyOn(h.reactor, 'settleRetention').mockRejectedValueOnce(new Error('fixture rejected action'));
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    expect(h.logs.filter((message) => message.includes('fixture rejected action'))).toHaveLength(1);
    await expect(h.reactor.settleRetention(address, action)).resolves.toEqual({
      kind: 'completed',
      outcome: 'discarded',
    });
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('keeps sealed failure stable across retries without restoring provider effect authority', async () => {
    const h = harness({
      discardArtifacts: async () => {
        throw new Error('provider refused removal');
      },
    });
    const { action, address } = await seed(h);
    const first = await h.reactor.settleRetention(address, action);
    expect(first).toMatchObject({ kind: 'failed' });
    h.restart();
    await expect(h.reactor.settleRetention(address, action)).resolves.toEqual(first);
    await expect(h.reactor.settleRetention(address, action)).resolves.toEqual(first);
    expect(h.providerEffects).toHaveLength(1);
  });

  it.each(['request-event', 'admission-backfill'] as const)(
    'recovers a rejected %s pass from its durable action without another provider effect',
    async (trigger) => {
      const h = harness();
      if (trigger === 'request-event') h.reactor.admitRetention();
      const settle = vi.spyOn(h.reactor, 'settleRetention').mockRejectedValueOnce(new Error('retention pass failed'));
      await seed(h);
      if (trigger === 'admission-backfill') h.reactor.admitRetention();
      await h.reactor.waitForIdle();
      expect(settle).toHaveBeenCalledTimes(1);
      expect(h.logs.filter((line) => line.includes('retention pass failed'))).toHaveLength(1);
      expect(h.providerEffects).toEqual([]);
      expect(retentionEvents(h)).toHaveLength(1);
      expect(h.read().finishing).toBe(true);

      h.reactor.admitRetention();
      await h.reactor.waitForIdle();
      await finish(h);
      expect(h.providerEffects).toHaveLength(1);
      expect(retentionEvents(h).map((event) => event.type)).toEqual([
        'job.retention.discard.requested',
        'job.retention.discard.completed',
      ]);
      expect(h.read().open).toBe(false);
    },
  );

  it('contains a subject fault without affecting a later independent conversation', async () => {
    const h = harness();
    h.start();
    h.accept();
    const action = { execution: 1, attempt: 1, handles: ['relative-artifact.jsonl'] };
    h.append(executionInput('job.retention.discard.requested', action));
    await expect(h.reactor.settleRetention({ jobId: EXECUTION_JOB_ID, execution: 1 }, action)).resolves.toMatchObject({
      kind: 'failed',
    });
    expect(continuation(h)).toMatchObject({ kind: 'failed' });
    await seed(h, OTHER_EXECUTION_JOB_ID);
    await finish(h, OTHER_EXECUTION_JOB_ID);
    expect(h.providerEffects).toHaveLength(1);
    expect(h.read(OTHER_EXECUTION_JOB_ID).open).toBe(false);
  });

  it('keeps startup observation separate from a rejected background attempt', async () => {
    const h = harness();
    await seed(h);
    const record = vi.fn();
    vi.spyOn(h.reactor, 'settleRetention').mockRejectedValueOnce(new Error('background rejection'));
    h.reactor.admitRetention();
    await h.reactor.scanStartup(h.lifetime.signal, { record });
    await h.reactor.waitForIdle();
    expect(record).toHaveBeenCalledExactlyOnceWith('job-conversation-retention', { subjects: 1 });
    expect(h.logs.join('')).toContain('background rejection');
    h.reactor.admitRetention();
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toHaveLength(1);
  });

  it('refuses an already queued admission callback after disposal', async () => {
    const h = harness();
    await seed(h);
    await h.reactor.dispose();
    const admission = Promise.resolve().then(() => h.reactor.admitRetention());
    await expect(admission).rejects.toThrow();
    await h.reactor.waitForIdle();
    expect(h.providerEffects).toEqual([]);
    expect(continuation(h)).toBeNull();
  });

  it('rejects direct settlement after disposal without changing the durable action', async () => {
    const h = harness();
    const { action, address } = await seed(h);
    await h.reactor.dispose();
    await expect(h.reactor.settleRetention(address, action)).rejects.toThrow();
    expect(retentionEvents(h)).toHaveLength(1);
    expect(h.providerEffects).toEqual([]);
  });

  it('leaves all subjects untouched when cancellation interrupts startup before admission', async () => {
    const h = harness();
    const first = await seed(h);
    const second = await seed(h, OTHER_EXECUTION_JOB_ID);
    h.lifetime.abort();
    await expect(h.reactor.scanStartup(h.lifetime.signal)).rejects.toThrow();
    expect(() => h.reactor.admitRetention()).toThrow();
    await h.reactor.waitForIdle();
    expect(h.runtime.storage.existsSync(first.handle)).toBe(true);
    expect(h.runtime.storage.existsSync(second.handle)).toBe(true);
    expect(h.providerEffects).toEqual([]);
  });

  it('aborts inside provider discard, waits for settlement and appends no completion after disposal', async () => {
    const entered = latch();
    const release = latch();
    const h = harness({
      discardArtifacts: async (input) => {
        entered.release();
        await release.promise;
        for (const handle of input.handles) input.runtime.storage.unlinkSync(handle);
        return { kind: 'discarded' };
      },
    });
    const { action, address } = await seed(h);
    const settlement = h.reactor.settleRetention(address, action);
    const rejected = expect(settlement).rejects.toThrow();
    await entered.promise;
    const disposal = h.reactor.dispose();
    release.release();
    await rejected;
    await disposal;
    expect(retentionEvents(h).map((event) => event.type)).toEqual(['job.retention.discard.requested']);
    const subject = {
      key: `${EXECUTION_JOB_ID}:1:1`,
      revision: canonicalRecoveryRevision(eventRevisionFields(h.accepted())),
    };
    expect(
      new RecoveryQuarantineStore(h.db, h.runtime.time).list().find((entry) => entry.subject.key === subject.key)
        ?.continuation?.key,
    ).not.toContain('"kind":"completed"');
    expect(h.read().finishing).toBe(true);
    const sources = createRecoverySourceRegistry();
    sources.register('job-conversation-retention', (exact, signal) =>
      createRetentionWorkRetryPlan(h.db, exact, signal),
    );
    expect(sources.has('job-conversation-retention')).toBe(true);
  });
});
