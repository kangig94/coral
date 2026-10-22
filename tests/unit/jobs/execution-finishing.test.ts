import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionFinisher, readExecutionFinishingState, type ExecutionFinishingPorts } from '#src/jobs/finishing.js';
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
import { createDeferred } from '#tools/testing/deferred.js';

const harnesses: ReturnType<typeof executionHarness>[] = [];
const directories: string[] = [];
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
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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

  it.each(['archive', 'discard'])('blocks continuation across a suspended %s effect', async (phase) => {
    const h = harness();
    accept(h);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const effects: string[] = [];
    const f = finisher(h, {
      settleRetention: async () => {
        expect(h.events().at(-1)?.type).toBe('job.retention.discard.requested');
        effects.push('archive');
        if (phase === 'archive') {
          entered.resolve();
          await release.promise;
        }
        effects.push('discard');
        if (phase === 'discard') {
          entered.resolve();
          await release.promise;
        }
        return { kind: 'completed', outcome: 'discarded' };
      },
    });
    const finished = f.owner.finish(address);
    await entered.promise;
    expect(effects).toEqual(phase === 'archive' ? ['archive'] : ['archive', 'discard']);
    expect(() => h.append(requestedExecution(2))).toThrow();
    expect(h.events().some((event) => event.type === 'job.execution.ended')).toBe(false);
    release.resolve();
    await finished;
    assertClosed(h);
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

  it('commits #2 → restores native bytes → rejects activation → accepts rejection → retains → ends once', async () => {
    const h = harness();
    const directory = mkdtempSync(join(tmpdir(), 'coral-execution-restore-'));
    directories.push(directory);
    const native = join(directory, 'conversation.jsonl');
    const original = Buffer.from('native conversation\n한글\n');
    let archive: Buffer | undefined;
    const effects: string[] = [];
    const f = finisher(h, {
      retentionAction: async () => ({ attempt: 0, handles: [native] }),
      settleRetention: async (address) => {
        const state = readExecutionFinishingState(h.db, address, h.readCtx);
        expect(state.kind).toBe('finishing');
        expect(h.events().at(-1)?.type).toBe('job.retention.discard.requested');
        archive = readFileSync(native);
        effects.push(`archive#${address.execution}`);
        unlinkSync(native);
        effects.push(`discard#${address.execution}`);
        return { kind: 'completed', outcome: 'discarded' };
      },
    });
    writeFileSync(native, original);
    accept(h);
    await f.owner.finish(address);
    expect(existsSync(native)).toBe(false);
    h.append(requestedExecution(2));
    effects.push('requested#2');
    writeFileSync(native, archive!, { flag: 'wx' });
    effects.push('restore#2');
    expect(readFileSync(native)).toEqual(original);
    const activate = vi.fn(() => {
      effects.push('reject-activation#2');
      throw new Error('activation rejected');
    });
    expect(activate).toThrow('activation rejected');
    const accepted = f.owner.accept({ jobId, execution: 2 }, (c) => {
      const cause = c.append(
        input('job.provider_failed', {
          execution: 2,
          provider: 'codex',
          reason: 'request_failed',
          message: 'activation rejected',
        }),
      );
      appendJobExecutionOutcomeAccepted(c, {
        jobId,
        execution: 2,
        terminal: { content: '', durationMs: 0, outcome: failedTerminalOutcome(cause) },
      });
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(500);
    await accepted;
    await f.owner.finish({ jobId, execution: 2 });
    const events = assertClosed(h, 2);
    expect(events.map((event) => event.type)).toEqual([
      'job.execution.requested',
      'job.provider_failed',
      'job.execution.outcome.accepted',
      'job.retention.discard.requested',
      'job.retention.discard.completed',
      'job.execution.ended',
    ]);
    expect(effects).toEqual([
      'archive#1',
      'discard#1',
      'requested#2',
      'restore#2',
      'reject-activation#2',
      'archive#2',
      'discard#2',
    ]);
    expect(archive).toEqual(original);
    expect(existsSync(native)).toBe(false);
    const count = h.events().length;
    const effectCount = effects.length;
    await f.owner.finish({ jobId, execution: 2 });
    expect(h.events()).toHaveLength(count);
    expect(effects).toHaveLength(effectCount);
    expect(() =>
      h.append(input('job.retention.discard.requested', { execution: 2, attempt: 1, handles: [native] })),
    ).toThrow();
  });

  it.each(['completion', 'rejection', 'setup failure', 'abort'])(
    'retains original %s ownership until its acceptance write recovers live',
    async (outcome) => {
      const h = harness(false);
      let fail = true;
      h.ctx.beforeAppend = (event) => {
        if (fail && event.type === 'job.execution.outcome.accepted') throw new Error('journal unavailable');
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

  it('rereads an uncertain acceptance acknowledgement and transfers to one finalizer', async () => {
    const h = harness(false);
    let loseAcknowledgement = true;
    const commit: CommitEventsFn = (cb) => {
      const result = h.commit(cb);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('ack lost');
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
  });

  it.each(['job.retention.discard.requested', 'job.retention.discard.completed', 'job.execution.ended'])(
    'recovers a %s write failure without reissuing an applied effect',
    async (type) => {
      const h = harness();
      accept(h);
      let fail = true;
      let issued = 0;
      const ledger = new Map<string, { kind: 'completed'; outcome: 'discarded' }>();
      h.ctx.beforeAppend = (event) => {
        if (fail && event.type === type) throw new Error('write failed');
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
      await vi.advanceTimersByTimeAsync(500);
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
        if (!readable) throw new Error('read unavailable');
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
