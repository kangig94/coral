import { createRecoverySourceRegistry, createRecoveryQuarantineRetryService } from '#src/recovery/source-registry.js';
import { SuccessionWriterParkedError } from '#src/store/db.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { loadJobProjectionDetail, listJobProjections } from '#src/jobs/read-queries.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ExecutionFinisher,
  ExecutionAcceptanceRefusedError,
  readExecutionFinishingState,
  readExecutionRetryStatus,
  createExecutionFinishingRetryPlan,
  type ExecutionFinishingPorts,
} from '#src/jobs/finishing.js';
import { appendJobExecutionOutcomeAccepted, failedTerminalOutcome } from '#src/jobs/terminal/recording.js';
import { applyProviderEventAtSeq, type ProviderEventEffectPort } from '#src/jobs/provider-event.js';
import { appendProviderTerminalInCommit } from '#src/coordinator/services/terminal-materializer.js';
import { commitWithinOpenTransaction, type CommitEventsFn } from '#src/store/append.js';
import {
  EXECUTION_JOB_ID as jobId,
  executionHarness,
  executionInput as input,
  openedJob,
  requestedExecution,
} from '#tests/helpers/job-executions.js';

const harnesses: ReturnType<typeof executionHarness>[] = [];
const address = { jobId, execution: 1 };
function harness(discard = true) {
  const h = executionHarness();
  harnesses.push(h);
  const opened = openedJob();
  if (opened.body.jobKind !== 'provider') throw new Error('provider fixture');
  if (discard) opened.body.conversation.retention = 'discard_provider_artifacts_on_terminal';
  h.append(opened, requestedExecution());
  return h;
}
function accept(h: ReturnType<typeof harness>, execution = 1) {
  h.commit((c) => {
    appendJobExecutionOutcomeAccepted(c, {
      jobId,
      execution,
      terminal: { content: 'original result', durationMs: 1, outcome: { kind: 'completed' } },
    });
    return undefined;
  });
}
function finisher(h: ReturnType<typeof harness>, overrides: Partial<ExecutionFinishingPorts> = {}) {
  const quiesce = vi.fn(async () => true);
  const retentionAction = vi.fn(async () => ({ attempt: 0, handles: ['/native'] }));
  const settleRetention = vi.fn(async () => ({ kind: 'completed', outcome: 'discarded' }) as const);
  const ports: ExecutionFinishingPorts = {
    recovery: { db: () => h.db, readCtx: h.readCtx, time: { now: () => Date.now() } },
    time: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    commit: h.commit,
    read: (address) => readExecutionFinishingState(h.db, address, h.readCtx),
    quiesce,
    retentionAction,
    settleRetention,
    ...overrides,
  };
  return { owner: new ExecutionFinisher(ports), ports, quiesce, retentionAction, settleRetention };
}
function assertClosed(h: ReturnType<typeof harness>, execution = 1) {
  const events = h.events().filter((event) => (event.body as { execution?: number }).execution === execution);
  expect(events.filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'job.execution.ended')).toHaveLength(1);
  expect(events.at(-1)?.type).toBe('job.execution.ended');
  return events;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const h of harnesses.splice(0)) h.db.close();
});

describe('accepted outcome finishing through real append validation', () => {
  it('waits for decisive settlement before retention and the sole end', async () => {
    const h = harness();
    accept(h);
    let settled = false;
    const f = finisher(h, { quiesce: async () => settled });
    const finished = f.owner.finish(address);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.owner.owns(address)).toBe(true);
    expect(h.events().map((event) => event.type)).toEqual([
      'job.opened',
      'job.execution.requested',
      'job.execution.outcome.accepted',
    ]);
    expect(() => h.append(requestedExecution(2))).toThrow();
    expect(f.settleRetention).not.toHaveBeenCalled();
    settled = true;
    await vi.advanceTimersByTimeAsync(500);
    await finished;
    const events = assertClosed(h);
    expect(events.map((event) => event.type)).toEqual([
      'job.execution.requested',
      'job.execution.outcome.accepted',
      'job.retention.discard.requested',
      'job.retention.discard.completed',
      'job.execution.ended',
    ]);
    const effects = f.settleRetention.mock.calls.length;
    await f.owner.finish(address);
    expect(f.settleRetention).toHaveBeenCalledTimes(effects);
    h.append(requestedExecution(2));
  });

  it('recovers an accepted failure without accepting a new result or resuming a provider', async () => {
    const h = harness();
    h.commit((c) => {
      const cause = c.append(input('job.interrupted', { execution: 1, trigger: 'restart', continuity: 'unavailable' }));
      appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution: 1,
        terminal: {
          content: 'Original result unavailable after producer loss.',
          durationMs: 0,
          outcome: failedTerminalOutcome(cause),
        },
      });
      return undefined;
    });
    h.append(input('job.retention.discard.requested', { execution: 1, attempt: 0, handles: ['/native'] }));
    const before = h.events().find((event) => event.type === 'job.execution.outcome.accepted');
    const recovered = finisher(h, {
      settleRetention: async () => ({ kind: 'failed', reason: 'Archive unavailable; native file kept.' }),
    });
    await recovered.owner.finish(address);
    expect(h.events().find((event) => event.type === 'job.execution.outcome.accepted')).toEqual(before);
    expect(recovered.retentionAction).not.toHaveBeenCalled();
    expect(assertClosed(h).map((event) => event.type)).toEqual([
      'job.execution.requested',
      'job.interrupted',
      'job.execution.outcome.accepted',
      'job.retention.discard.requested',
      'job.retention.discard.failed',
      'job.execution.ended',
    ]);
  });

  it('recovers after retention already closed by appending only the end', async () => {
    const h = harness();
    accept(h);
    h.append(
      input('job.retention.discard.requested', { execution: 1, attempt: 0, handles: ['/native'] }),
      input('job.retention.discard.completed', {
        execution: 1,
        attempt: 0,
        handles: ['/native'],
        outcome: 'discarded',
      }),
    );
    const before = h.events().length;
    const f = finisher(h);
    await f.owner.finish(address);
    expect(
      h
        .events()
        .slice(before)
        .map((event) => event.type),
    ).toEqual(['job.execution.ended']);
    expect(f.settleRetention).not.toHaveBeenCalled();
    assertClosed(h);
  });

  it('refuses finalization without an accepted outcome', async () => {
    const h = harness();
    const f = finisher(h);
    await expect(f.owner.finish(address)).rejects.toThrow(/committed accepted outcome/);
    expect(f.quiesce).not.toHaveBeenCalled();
    expect(f.settleRetention).not.toHaveBeenCalled();
  });

  it.each(['completion', 'rejection', 'setup failure', 'abort'])(
    'retains original %s ownership until its acceptance write recovers live',
    async (outcome) => {
      const h = harness(false);
      let fail = true;
      h.ctx.beforeAppend = (event) => {
        if (fail && event.type === 'job.execution.outcome.accepted')
          throw Object.assign(new Error('journal unavailable'), { code: 'EIO' });
      };
      const f = finisher(h);
      let writes = 0;
      const accepted = f.owner.accept(address, (c) => {
        writes++;
        if (outcome === 'completion')
          appendJobExecutionOutcomeAccepted(c, {
            ...address,
            terminal: { content: 'original completion', durationMs: 1, outcome: { kind: 'completed' } },
          });
        else if (outcome === 'abort') {
          c.append(input('job.execution.aborted', { execution: 1, reason: 'user_abort' }));
          appendJobExecutionOutcomeAccepted(c, {
            ...address,
            terminal: { content: '', durationMs: 1, outcome: { kind: 'aborted', reason: 'user_abort' } },
          });
        } else {
          const cause = c.append(
            input('job.provider_failed', {
              execution: 1,
              provider: 'codex',
              reason: 'request_failed',
              message: `original ${outcome}`,
            }),
          );
          appendJobExecutionOutcomeAccepted(c, {
            ...address,
            terminal: { content: '', durationMs: 1, outcome: failedTerminalOutcome(cause) },
          });
        }
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.owner.owns(address)).toBe(true);
      expect(f.quiesce).not.toHaveBeenCalled();
      expect(readExecutionFinishingState(h.db, address, h.readCtx).kind).toBe('unaccepted');
      expect(() => h.append(requestedExecution(2))).toThrow();
      fail = false;
      await vi.advanceTimersByTimeAsync(1000);
      await accepted;
      await f.owner.finish(address);
      expect(writes).toBeGreaterThan(1);
      const events = assertClosed(h);
      expect(events.filter((event) => event.type === 'job.provider_failed')).toHaveLength(
        outcome === 'rejection' || outcome === 'setup failure' ? 1 : 0,
      );
      expect(events.find((event) => event.type === 'job.execution.outcome.accepted')?.body).toEqual(
        expect.objectContaining({
          terminal: expect.objectContaining({ content: outcome === 'completion' ? 'original completion' : '' }),
        }),
      );
    },
  );

  it('returns a deterministic refusal after a transient write failure without retaining retry ownership', async () => {
    const h = harness(false);
    const f = finisher(h);
    const refusal = new ExecutionAcceptanceRefusedError('checkpoint changed');
    let writes = 0;
    const producer = f.owner.accept(address, () => {
      if (writes++ === 0) throw Object.assign(new Error('store unavailable'), { code: 'EIO' });
      throw refusal;
    });
    const rejected = expect(producer).rejects.toBe(refusal);
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(writes).toBe(2);
    expect(f.owner.owns(address)).toBe(false);
    expect(f.owner.status(address)).toBeNull();
    expect(readExecutionRetryStatus(h.db, address)).toBeNull();
    expect(readExecutionFinishingState(h.db, address, h.readCtx)).toEqual({ kind: 'unaccepted' });
    expect(f.quiesce).not.toHaveBeenCalled();
    expect(h.events().map((event) => event.type)).toEqual(['job.opened', 'job.execution.requested']);
  });

  it.each([new Error('ack lost'), new ExecutionAcceptanceRefusedError('ack lost')])(
    'rereads an uncertain acceptance acknowledgement (%s) and transfers to one finalizer',
    async (acknowledgementError) => {
      const h = harness(false);
      let loseAcknowledgement = true;
      const commit: CommitEventsFn = (cb) => {
        const result = h.commit(cb);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw acknowledgementError;
        }
        return result;
      };
      const f = finisher(h, { commit });
      let writes = 0;
      const producer = f.owner.accept(address, (c) => {
        writes++;
        appendJobExecutionOutcomeAccepted(c, {
          ...address,
          terminal: { content: 'preserved', durationMs: 1, outcome: { kind: 'completed' } },
        });
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(500);
      await producer;
      await f.owner.finish(address);
      expect(writes).toBe(1);
      assertClosed(h);
    },
  );

  it.each(['job.retention.discard.requested', 'job.retention.discard.completed', 'job.execution.ended'])(
    'recovers a %s write failure without reissuing an applied effect',
    async (type) => {
      const h = harness();
      accept(h);
      let fail = true;
      let issued = 0;
      const ledger = new Map<string, { kind: 'completed'; outcome: 'discarded' }>();
      h.ctx.beforeAppend = (event) => {
        if (fail && event.type === type) throw Object.assign(new Error('write failed'), { code: 'EIO' });
      };
      const f = finisher(h, {
        settleRetention: async (address, action) => {
          const key = `${address.jobId}:${address.execution}:${action.attempt}`;
          if (!ledger.has(key)) {
            issued++;
            ledger.set(key, { kind: 'completed', outcome: 'discarded' });
          }
          return ledger.get(key)!;
        },
      });
      const finished = f.owner.finish(address);
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.owner.owns(address)).toBe(true);
      expect(issued).toBe(type === 'job.retention.discard.requested' ? 0 : 1);
      expect(() => h.append(requestedExecution(2))).toThrow();
      fail = false;
      await vi.advanceTimersByTimeAsync(5000);
      await finished;
      expect(issued).toBe(1);
      assertClosed(h);
    },
  );

  it('does not append blindly while acceptance evidence is unreadable', async () => {
    const h = harness(false);
    let readable = false;
    let writes = 0;
    const f = finisher(h, {
      read: (address) => {
        if (!readable) throw Object.assign(new Error('read unavailable'), { code: 'EIO' });
        return readExecutionFinishingState(h.db, address, h.readCtx);
      },
    });
    const producer = f.owner.accept(address, (c) => {
      writes++;
      appendJobExecutionOutcomeAccepted(c, {
        ...address,
        terminal: { content: 'preserved', durationMs: 1, outcome: { kind: 'completed' } },
      });
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toBe(0);
    expect(f.owner.owns(address)).toBe(true);
    readable = true;
    await vi.advanceTimersByTimeAsync(1000);
    await producer;
    await f.owner.finish(address);
    expect(writes).toBe(1);
    assertClosed(h);
  });

  it('accepts a provider terminal with its watermark and settlement intent, then waits to end', async () => {
    const h = harness(false);
    h.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('test-watermark', '0');
    let settled = false;
    const port: ProviderEventEffectPort<null> = {
      runInTransaction: async (execute) => {
        h.db.exec('BEGIN IMMEDIATE');
        try {
          const result = await execute(null);
          h.db.exec('COMMIT');
          return result;
        } catch (error) {
          h.db.exec('ROLLBACK');
          throw error;
        }
      },
      verifyIdentity: async () => true,
      readWatermark: async () =>
        Number(
          h.db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get('test-watermark')!
            .value,
        ),
      advanceWatermark: async (_tx, _identity, seq) => {
        h.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(seq), 'test-watermark');
      },
      appendProgress: async () => {
        throw new Error('unexpected progress');
      },
      appendConversationEvent: async () => {
        throw new Error('unexpected continuity');
      },
      appendJobInterrupted: async () => {
        throw new Error('unexpected interruption');
      },
      acceptExecutionOutcome: async (_tx, _identity, _seq, disposition) => {
        if (disposition.kind !== 'direct') throw new Error('expected provider terminal');
        commitWithinOpenTransaction(
          h.db,
          (c) => {
            appendProviderTerminalInCommit(c, disposition.body, address);
            return undefined;
          },
          h.ctx,
        );
      },
      markSettlementPending: async () => {
        h.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('test-settlement', 'pending');
      },
    };
    const receipt = {
      identity: { jobId, operationId: 'operation', proxyInstanceId: 'proxy', buildSetId: 'build' },
      seq: 1,
      event: {
        kind: 'terminal',
        terminal: { content: 'provider result', durationMs: 1, outcome: { kind: 'completed' } },
        diagnostics: {},
      },
    } as const;
    await expect(applyProviderEventAtSeq(port, receipt)).resolves.toEqual({
      kind: 'ack',
      committedThroughProviderSeq: 1,
    });
    expect(h.events().at(-1)?.type).toBe('job.execution.outcome.accepted');
    await applyProviderEventAtSeq(port, receipt);
    expect(h.events().filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
    const f = finisher(h, { quiesce: async () => settled });
    const finished = f.owner.finish(address);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.events().at(-1)?.type).toBe('job.execution.outcome.accepted');
    settled = true;
    await vi.advanceTimersByTimeAsync(500);
    await finished;
    assertClosed(h);
  });
});

it.each([new TypeError('producer defect'), new Error('validator rejected the outcome')])(
  'preserves its producer through bounded retries and durable quarantine: %s',
  async (error) => {
    const h = harness(false);
    let failed = true;
    const f = finisher(h, { log: vi.fn() });
    const producer = f.owner.accept(address, (c) => {
      if (failed) throw error;
      appendJobExecutionOutcomeAccepted(c, {
        ...address,
        terminal: { content: 'preserved result', durationMs: 1, outcome: { kind: 'completed' } },
      });
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(f.owner.status(address)).toMatchObject({
      kind: 'blocked',
      stage: 'accept',
      successor: 'recovery-quarantine',
    });
    expect(f.owner.owns(address)).toBe(true);
    expect(readExecutionRetryStatus(h.db, address)).toEqual(f.owner.status(address));
    expect(loadJobProjectionDetail(h.db, jobId, h.readCtx).status?.finishingStatus).toEqual(f.owner.status(address));
    expect(listJobProjections(h.db, h.readCtx)[0].status.finishingStatus).toEqual(f.owner.status(address));
    const record = RecoveryQuarantineStore.readOnly(h.db)
      .list()
      .find((row) => row.boundary === 'job-execution-finishing')!;
    expect(record.state).toBe('active');
    const sources = createRecoverySourceRegistry();
    sources.register('job-execution-finishing', (subject, signal) =>
      createExecutionFinishingRetryPlan(f.owner, h.db, subject, signal),
    );
    const retry = createRecoveryQuarantineRetryService({
      sources,
      quarantine: new RecoveryQuarantineStore(h.db, { now: () => Date.now() }),
      instanceId: 'serving-owner',
      ids: { uuid: () => 'retry-token' },
      isRetryAdmitted: () => true,
    });
    const request = {
      boundary: record.boundary,
      key: record.subject.key,
      revision: record.subject.revision.kind === 'fingerprint' ? record.subject.revision.value : null,
    };
    await expect(retry.clear(request)).resolves.toMatchObject({ disposition: 'quarantined' });
    expect(readExecutionRetryStatus(h.db, address)).toMatchObject({ kind: 'blocked', reason: error.message });
    failed = false;
    await expect(retry.clear(request)).resolves.toMatchObject({ disposition: 'advanced' });
    await producer;
    expect(readExecutionRetryStatus(h.db, address)).toBeNull();
    expect(assertClosed(h).find((event) => event.type === 'job.execution.outcome.accepted')?.body).toMatchObject({
      terminal: { content: 'preserved result' },
    });
    await f.owner.dispose();
  },
);

it('cancels a transient producer retry before its journal closes', async () => {
  const h = harness(false);
  const failure = Object.assign(new Error('disk busy'), { code: 'EBUSY' });
  const f = finisher(h, {
    log: vi.fn(),
    commit: () => {
      throw failure;
    },
  });
  const producer = f.owner.accept(address, () => undefined);
  const rejected = expect(producer).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.owner.status(address)?.successor).toBe('live-retry');
  await f.owner.dispose();
  await rejected;
  expect(f.owner.owns(address)).toBe(false);
});

it('quarantines an empty outcome write until shutdown instead of losing the producer', async () => {
  const h = harness(false);
  const f = finisher(h, { log: vi.fn() });
  const producer = f.owner.accept(address, () => undefined);
  const rejected = expect(producer).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.owner.status(address)).toMatchObject({ kind: 'blocked', reason: expect.stringContaining('did not commit') });
  expect(f.owner.owns(address)).toBe(true);
  await f.owner.dispose();
  await rejected;
});

it('keeps a detached finalizer in durable quarantine with a serving retry exit', async () => {
  const h = harness(false);
  accept(h);
  let failing = true;
  const f = finisher(h, {
    log: vi.fn(),
    quiesce: async () => {
      if (failing) throw new Error('settlement unavailable');
      return true;
    },
  });
  f.owner.schedule(address);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(f.owner.status(address)).toMatchObject({ kind: 'blocked', stage: 'finish', successor: 'recovery-quarantine' });
  expect(f.owner.owns(address)).toBe(true);
  failing = false;
  await f.owner.redrive(address);
  assertClosed(h);
  await f.owner.dispose();
});

it('gives an adopted admission a fresh bounded retry window after automatic redrive', async () => {
  const h = harness(false);
  const f = finisher(h, { log: vi.fn() });
  let repaired = false;
  let transientFailure = false;
  const reconcile = vi.fn(async () => {
    if (!repaired) throw new Error('admission evidence unavailable');
    if (!transientFailure) {
      transientFailure = true;
      throw new Error('transient read failure after repair');
    }
    accept(h);
    await f.owner.finish(address);
  });
  const admission = f.owner.adoptAdmission(address, reconcile);
  for (let n = 0; n < 60 && f.owner.status(address)?.kind !== 'blocked'; n++) await vi.advanceTimersByTimeAsync(500);
  expect(f.owner.status(address)).toMatchObject({ kind: 'blocked', successor: 'live-retry' });
  expect(readExecutionRetryStatus(h.db, address)).toBeNull();
  repaired = true;
  for (let n = 0; n < 60 && f.owner.owns(address); n++) await vi.advanceTimersByTimeAsync(500);
  await admission.completion;
  expect(transientFailure).toBe(true);
  assertClosed(h);
  expect(readExecutionRetryStatus(h.db, address)).toBeNull();
  expect(f.owner.status(address)).toBeNull();
  expect(f.owner.owns(address)).toBe(false);
  await f.owner.dispose();
});

it('leaves unaccepted execution redrive to interrupted startup recovery', async () => {
  const h = harness(false);
  const f = finisher(h);
  await f.owner.redrive(address);
  expect(f.owner.owns(address)).toBe(false);
  expect(h.events().map((event) => event.type)).toEqual(['job.opened', 'job.execution.requested']);
  await f.owner.dispose();
});

it.each(['accept', 'finish'] as const)(
  'waits for succession unpark during %s and preserves the original result',
  async (stage) => {
    const h = harness(false);
    if (stage === 'finish') accept(h);
    let unpark!: () => void;
    let parked = true;
    const unparked = new Promise<void>((resolve) => {
      unpark = () => {
        parked = false;
        resolve();
      };
    });
    const f = finisher(h, {
      commit: (write) => {
        if (parked) throw new SuccessionWriterParkedError(unparked);
        return h.commit(write);
      },
    });
    const task =
      stage === 'finish'
        ? f.owner.finish(address)
        : f.owner.accept(address, (c) => {
            appendJobExecutionOutcomeAccepted(c, {
              ...address,
              terminal: { content: 'original result', durationMs: 1, outcome: { kind: 'completed' } },
            });
            return undefined;
          });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.owner.owns(address)).toBe(true);
    expect(f.owner.status(address)).toBeNull();
    expect(h.events().some((event) => event.type === 'job.execution.ended')).toBe(false);
    unpark();
    await task;
    await f.owner.finish(address);
    expect(assertClosed(h).find((event) => event.type === 'job.execution.outcome.accepted')?.body).toMatchObject({
      terminal: { content: 'original result' },
    });
    await f.owner.dispose();
  },
);

it.each(['accept', 'finish'] as const)('disposes while succession stays parked during %s', async (stage) => {
  const h = harness(false);
  if (stage === 'finish') accept(h);
  const f = finisher(h, {
    commit: () => {
      throw new SuccessionWriterParkedError(new Promise<void>(() => {}));
    },
  });
  const task = stage === 'finish' ? f.owner.finish(address) : f.owner.accept(address, () => undefined);
  const rejected = expect(task).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(0);
  await f.owner.dispose();
  await rejected;
  expect(h.events().some((event) => event.type === 'job.execution.ended')).toBe(false);
});

it.each(['quiesce', 'retentionAction', 'settleRetention'] as const)('disposes while %s never settles', async (port) => {
  const h = harness();
  accept(h);
  const f = finisher(h, { [port]: () => new Promise<never>(() => {}) });
  const task = f.owner.finish(address);
  const rejected = expect(task).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(0);
  await f.owner.dispose();
  await rejected;
  expect(h.events().some((event) => event.type === 'job.execution.ended')).toBe(false);
});

it('releases a finalizer when retention belongs to another owner', async () => {
  const h = harness();
  accept(h);
  const f = finisher(h, { settleRetention: async () => ({ kind: 'not-owned' }) });
  await f.owner.finish(address);
  expect(f.owner.status(address)).toBeNull();
  expect(f.owner.owns(address)).toBe(false);
  expect(readExecutionRetryStatus(h.db, address)).toBeNull();
  await f.owner.dispose();
});

it('hands a repaired finishing retry back to the live owner while quiescence is still pending', async () => {
  const h = harness(false);
  accept(h);
  let broken = true;
  let quiescent = false;
  const f = finisher(h, {
    log: vi.fn(),
    quiesce: async () => {
      if (broken) throw new Error('settlement failed');
      return quiescent;
    },
  });
  f.owner.schedule(address);
  await vi.advanceTimersByTimeAsync(20_000);
  const quarantine = new RecoveryQuarantineStore(h.db, { now: () => Date.now() });
  const record = quarantine.list()[0];
  const sources = createRecoverySourceRegistry();
  sources.register('job-execution-finishing', (subject, signal) =>
    createExecutionFinishingRetryPlan(f.owner, h.db, subject, signal),
  );
  const service = createRecoveryQuarantineRetryService({
    sources,
    quarantine,
    instanceId: 'serving',
    ids: { uuid: () => 'token' },
    isRetryAdmitted: () => true,
  });
  broken = false;
  const request = {
    boundary: record.boundary,
    key: record.subject.key,
    revision: record.subject.revision.kind === 'fingerprint' ? record.subject.revision.value : null,
  };
  await expect(service.clear(request)).resolves.toMatchObject({ disposition: 'continuation' });
  expect(quarantine.read(record.boundary, record.subject.key)?.state).toBe('continuation');
  expect(readExecutionRetryStatus(h.db, address)).toMatchObject({ kind: 'retrying' });
  quiescent = true;
  await vi.advanceTimersByTimeAsync(500);
  await f.owner.finish(address);
  assertClosed(h);
  expect(quarantine.list()).toEqual([]);
  await f.owner.dispose();
});

it('releases a cancelled retry claim so the same serving coordinator can retry again', async () => {
  const h = harness(false);
  accept(h);
  let broken = true;
  let release!: () => void;
  const gate = new Promise<boolean>((resolve) => {
    release = () => resolve(true);
  });
  const f = finisher(h, {
    log: vi.fn(),
    quiesce: async () => {
      if (broken) throw new Error('settlement failed');
      return gate;
    },
  });
  f.owner.schedule(address);
  await vi.advanceTimersByTimeAsync(20_000);
  const quarantine = new RecoveryQuarantineStore(h.db, { now: () => Date.now() });
  const record = quarantine.list()[0];
  const sources = createRecoverySourceRegistry();
  sources.register('job-execution-finishing', (subject, signal) =>
    createExecutionFinishingRetryPlan(f.owner, h.db, subject, signal),
  );
  const service = createRecoveryQuarantineRetryService({
    sources,
    quarantine,
    instanceId: 'serving',
    ids: { uuid: () => 'token' },
    isRetryAdmitted: () => true,
  });
  const request = {
    boundary: record.boundary,
    key: record.subject.key,
    revision: record.subject.revision.kind === 'fingerprint' ? record.subject.revision.value : null,
  };
  broken = false;
  const cancelled = new AbortController();
  const attempt = service.clear(request, cancelled.signal);
  const rejected = expect(attempt).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(0);
  expect(quarantine.read(record.boundary, record.subject.key)?.state).toBe('retrying');
  cancelled.abort();
  await rejected;
  expect(quarantine.read(record.boundary, record.subject.key)?.state).toBe('active');
  const retried = service.clear(request);
  release();
  await expect(retried).resolves.toMatchObject({ disposition: 'advanced' });
  expect(assertClosed(h).find((event) => event.type === 'job.execution.outcome.accepted')?.body).toMatchObject({
    terminal: { content: 'original result' },
  });
  await f.owner.dispose();
});
