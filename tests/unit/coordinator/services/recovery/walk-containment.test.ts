import { ExecutionAcceptanceRefusedError } from '#src/jobs/finishing.js';
import { expect, it, vi } from 'vitest';
import { createRecoveryWalk } from '#src/coordinator/services/recovery/walk.js';
import { ProcessContainmentError } from '#src/infra/process-containment.js';
import type { CoordinatorRecoveryItem } from '#src/coordinator/services/recovery/snapshot.js';
import { createFailureDomainContainmentObservation } from '#src/infra/process-containment.js';
import { COORDINATOR_TERMINAL_OBLIGATION } from '#src/coordinator/services/recovery/actions.js';
import { defineRecoverySource, RecoveryContainment, type RecoveryQuarantineRecord } from '#src/recovery/containment.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

it.each(['direct', 'typed-cause'] as const)(
  'quarantines a %s containment refusal caught by the real recovery policy instead of writing a fault terminal',
  async (form) => {
    const runtime = new SimulationRuntime();
    const settleTerminal = vi.fn(() => []);
    const unexpected = (): never => {
      throw new Error('unexpected recovery operation');
    };
    const walk = createRecoveryWalk({
      runtime,
      progressStore: {} as never,
      eventBus: {} as never,
      log: vi.fn(),
      quarantine: {} as never,
      source: unexpected,
      settleCoordinatorRecoveryItem: settleTerminal,
    });
    const item = { jobId: 'job' } as CoordinatorRecoveryItem;
    const commit = vi.fn() as never;
    const policy = walk.createCoordinatorJobRecoveryPolicy(
      {
        signal: new AbortController().signal,
        coordinatorCommit: commit,
        summary: 'durable recovery',
        settle: async () => {
          const refusal = new ProcessContainmentError(
            'process_containment_reap_failed',
            'job leaf became unreadable before commit',
          );
          throw form === 'typed-cause'
            ? new ExecutionAcceptanceRefusedError('finalization refused', { cause: refusal })
            : refusal;
        },
        settleFailure: (failed, error, controls) =>
          walk.settleUnexpectedRecoveryFailure(failed, item.jobId, 'durable recovery', error, commit, controls.report),
      },
      [],
    );
    await expect(policy.settle(item)).resolves.toMatchObject({ kind: 'quarantine' });
    expect(settleTerminal).not.toHaveBeenCalled();
  },
);

it('holds a subject at the actual delayed boundary cleanup and continues its sibling', async () => {
  const runtime = new SimulationRuntime();
  const records = new Map<string, RecoveryQuarantineRecord>();
  const quarantine = {
    read: (_boundary: string, key: string) => records.get(key) ?? null,
    upsert: (write: RecoveryQuarantineRecord) => {
      records.set(write.subject.key, write);
      return true;
    },
    delete: () => true,
  };
  const terminal = vi.fn(() => []);
  const walk = createRecoveryWalk({
    runtime,
    progressStore: {} as never,
    eventBus: {} as never,
    log: vi.fn(),
    quarantine: quarantine as never,
    source: () => {
      throw new Error('unused');
    },
    settleCoordinatorRecoveryItem: terminal,
  });
  let empty = true;
  const leaf = createFailureDomainContainmentObservation({
    observe: () => (empty ? { kind: 'absent' as const } : { kind: 'missing' as const }),
  });
  const remove = vi.fn();
  const policy = walk.createCoordinatorJobRecoveryPolicy(
    {
      signal: new AbortController().signal,
      coordinatorCommit: vi.fn() as never,
      summary: 'delayed cleanup',
      settle: async (item, controls) => {
        controls.setProcessLocalCleanup(() => {
          if (item.jobId === 'held' && !leaf.permitsIndependentAbsenceDecision()) {
            throw new ProcessContainmentError('process_containment_reap_failed', 'the existing job leaf disappeared');
          }
          remove(item.jobId);
        });
        if (item.jobId === 'held')
          queueMicrotask(() => {
            empty = false;
          });
        return {
          kind: 'advanced',
          outcome: 'settled',
          detail: 'test subject settled',
          facts: [{ obligation: COORDINATOR_TERMINAL_OBLIGATION, outcome: 'done', authorityRef: 'fixture' }],
        };
      },
    },
    [],
  );
  const source = defineRecoverySource({
    boundary: 'delayed-cleanup',
    scanSubject: { key: 'scan', revision: { kind: 'until-cleared' } },
    scan: () => [{ jobId: 'held' }, { jobId: 'sibling' }],
    subject: (item: { jobId: string }) => ({ key: item.jobId, revision: { kind: 'until-cleared' as const } }),
  });
  const report = await RecoveryContainment.each(source, {
    ...policy,
    signal: new AbortController().signal,
    issueReceipts: true,
    quarantine,
    hydrate: (item) => item as CoordinatorRecoveryItem,
  });
  expect(report).toMatchObject({ advanced: 1, quarantined: 1 });
  expect(report.receipts).toHaveLength(1);
  expect(records.has('held')).toBe(true);
  expect(remove.mock.calls).toEqual([['sibling']]);
  expect(terminal).not.toHaveBeenCalled();
});
