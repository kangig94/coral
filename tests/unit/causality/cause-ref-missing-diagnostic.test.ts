import * as fs from 'node:fs';
import { join } from 'node:path';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { describeTerminalOutcome, type TerminalOutcome } from '#src/jobs/outcome.js';
import type { StoreReadContext } from '#src/store/body-codec.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { createCauseRefRenderer } from '#src/causality/render.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';

const renderer = createCauseRefRenderer(defaultEventDescribers);

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const RAW_EVENT_READ_CTX: StoreReadContext = {
  schemas: new Map(),
  upcasters: createDefaultUpcasterRegistry(),
};

function createStore(): { db: Database; store: CoralStore } {
  const db = newRawDatabase(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
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
