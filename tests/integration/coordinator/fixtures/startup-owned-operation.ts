import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';

import {
  ProviderOperationMutationSetClosedError,
  insertProviderOperation,
  readProviderOperation,
} from '#src/store/provider-operation-journal.js';
import { providerOperationRecordSchema } from '#src/store/provider-operation-record.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

async function run(): Promise<void> {
  const mode = process.argv[2];
  let expire!: () => void;
  let release!: () => void;
  let attached!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    attached = resolve;
  });
  const errors: string[] = [];
  const stops: string[] = [];
  let attachmentCount = 0;
  const harness = createProviderOperationReconcilerHarness({
    attachOperation: async () => {
      attachmentCount += 1;
      attached();
      await pending;
      return { state: 'attached', replayFromProviderSeq: 1 };
    },
    stopOperation: async (cause) => {
      stops.push(cause);
    },
    onError: (error) => errors.push(error),
    time: {
      setTimeout: (callback, delay) => {
        if (delay === 500) expire = callback;
        return { unref: () => undefined };
      },
      clearTimeout: () => undefined,
    },
  });
  const record = providerOperationRecordSchema.parse({
    ...providerOperationRecord('executing'),
    ...(mode === 'abort-rekey' || mode === 'negative-control'
      ? {
          controlIntent: {
            kind: 'rekey-refusal-containment',
            cause: 'coordinator_rekey_refused',
            reason: 'The receiver refused the prepared source reservation.',
            requestedAt: '2026-08-09T12:34:56.000Z',
          },
        }
      : {}),
  });
  assert(record.phase === 'executing');
  insertProviderOperation(harness.db, record);
  const startup = harness.reconciler.reconcileAtStartup(
    harness.startupOwnership.ownershipFor([record]),
    new AbortController().signal,
  );
  await entered;
  harness.advance(500);
  expire();
  await startup;
  assert.equal(harness.reconciler.startupStatus()?.phase, 'detached');
  assert.notEqual(harness.startupOwnership.binding.reservationFor(record.operation.jobId), null);

  try {
    if (mode === 'negative-control') {
      void harness.reconciler.reconcile(record, harness.authority);
      await nextTurn();
      assert.fail('Node must terminate on the discarded ownership rejection.');
    } else if (mode === 'begin') {
      const operation = { ...harness.record.operation, jobId: randomUUID(), operationId: randomUUID() };
      await assert.rejects(
        harness.reconciler.begin({
          record: { ...harness.record, operation },
          attempt: {} as never,
          authority: harness.authority,
          signal: new AbortController().signal,
        }),
        ProviderOperationMutationSetClosedError,
      );
      assert.equal(readProviderOperation(harness.db, operation), null);
    } else if (mode === 'control-established') {
      harness.reconciler.onControlEstablished(harness.authority);
    } else {
      const decision = harness.reconciler.requestStops([record.operation.jobId], 'signal_abort');
      assert.equal(decision.kind, 'answered');
      if (decision.kind === 'answered') {
        assert.deepEqual(decision.outcomes.get(record.operation.jobId), { kind: 'recorded' });
      }
      const current = readProviderOperation(harness.db, record.operation);
      assert.equal(current?.phase, 'executing');
      if (current?.phase === 'executing') {
        assert.deepEqual(
          current.controlIntent,
          mode === 'abort-rekey'
            ? record.controlIntent
            : {
                kind: 'stop',
                cause: 'signal_abort',
                requestedAt: new Date(600).toISOString(),
              },
        );
      }
    }
    await nextTurn();
    assert.equal(attachmentCount, 1);
    assert.deepEqual(stops, []);
    assert.deepEqual(errors, []);
    assert.equal(harness.reconciler.startupStatus()?.phase, 'detached');
    assert.notEqual(harness.startupOwnership.binding.reservationFor(record.operation.jobId), null);
  } finally {
    release();
    await nextTurn();
    assert.equal(harness.reconciler.startupStatus(), null);
    assert.deepEqual(
      stops,
      mode === 'abort-rekey' ? ['coordinator_rekey_refused'] : mode === 'abort-run' ? ['signal_abort'] : [],
    );
    assert(errors.every((error) => mode === 'abort-run' && error.includes('kind=operation-retry-scheduled')));
    assert.equal(harness.reconciler.stop().kind, 'drained');
    harness.db.close();
  }
}

run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
