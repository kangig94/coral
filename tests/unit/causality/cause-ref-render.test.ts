import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { CoralStore } from '#src/read-model/coral-store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';

const renderer = createCauseRefRenderer(defaultEventDescribers);

const NOW = new Date('2026-04-22T00:00:00.000Z');

function createStore(): { db: Database; store: CoralStore } {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return { db, store: new CoralStore(db, createDefaultStoreReadContext()) };
}

function insertEvent(
  db: Database,
  input: {
    seq: number;
    type: string;
    stream: { kind: 'job' | 'session' | 'workflow' | 'discuss'; id: string };
    body: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO events (
      seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(
    input.seq,
    NOW.toISOString(),
    input.type,
    input.stream.kind,
    input.stream.id,
    Buffer.from(JSON.stringify(input.body), 'utf-8'),
  );
}

function renderRootEventDescription(input: {
  type: string;
  stream: { kind: 'job' | 'session' | 'workflow' | 'discuss'; id: string };
  body: unknown;
}): string {
  const { db, store } = createStore();
  try {
    insertEvent(db, { seq: 1, ...input });
    return renderer.describe(
      {
        stream: input.stream,
        seq: 1,
      },
      store,
    );
  } finally {
    db.close();
  }
}

describe('cause-ref job rendering', () => {
  it('surfaces indeterminate provider activation with a durable inspection command', () => {
    expect(
      renderRootEventDescription({
        type: 'job.progress.emitted',
        stream: { kind: 'job', id: 'job-activation-unknown' },
        body: {
          kind: 'domain',
          stage: 'provider_operation_failed',
          message: 'Provider containment disappeared after activation may have begun.',
          detail: { code: 'activation_indeterminate' },
        },
      }),
    ).toBe(
      'Provider containment disappeared after activation may have begun. ' +
        'Activation indeterminate [activation_indeterminate]: the provider may have started. ' +
        'Run `coral-cli jobs detail job-activation-unknown` to inspect the durable job record before deciding whether to retry.',
    );
  });
});
