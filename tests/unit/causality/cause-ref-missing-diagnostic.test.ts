import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { describeTerminalOutcome, type TerminalOutcome } from '#src/jobs/outcome.js';
import type { StoreReadContext } from '#src/store/body-codec.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';

const renderer = createCauseRefRenderer(defaultEventDescribers);

const RAW_EVENT_READ_CTX: StoreReadContext = {
  schemas: new Map(),
  streamKinds: new Map(),
  bodyCodec: createEventBodyCodec(),
};

function createStore(): { db: Database; store: CoralStore } {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return { db, store: new CoralStore(db, RAW_EVENT_READ_CTX) };
}

describe('describeCauseRef missing cause diagnostic', () => {
  it('renders a missing-cause diagnostic with the terminal outcome context', () => {
    const { db, store } = createStore();
    try {
      const terminalOutcome: TerminalOutcome = {
        kind: 'failed',
        causeRef: {
          stream: { kind: 'job', id: 'job-phantom' },
          seq: 1,
        },
      };

      const hint = `Original terminal outcome: ${describeTerminalOutcome(terminalOutcome)}`;
      expect(
        renderer.describe(
          {
            stream: { kind: 'job', id: 'job-phantom' },
            seq: 1,
          },
          store,
          hint,
        ),
      ).toBe(`<missing job/job-phantom/1> ${hint}`);
    } finally {
      db.close();
    }
  });
});
