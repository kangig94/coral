import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { describeTerminalOutcome, type TerminalOutcome } from '#src/jobs/outcome.js';
import type { StoreReadContext } from '#src/store/body-codec.js';
import { createEmptyRegistry } from '#src/store/envelope.js';
import { CoralStore } from '#src/store/index.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { describeCauseRef } from '#src/jobs/read/cause-ref-render.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};
const RAW_EVENT_READ_CTX: StoreReadContext = {
  schemas: new Map(),
  upcasters: createEmptyRegistry(),
};

function createStore(): { db: InstanceType<typeof Database>; store: CoralStore } {
  const db = new Database(':memory:');
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

      expect(
        describeCauseRef(
          {
            stream: { kind: 'job', id: 'job-phantom' },
            seq: 1,
          },
          store,
          terminalOutcome,
        ),
      ).toBe(
        `<missing job/job-phantom/1> Original terminal outcome: ${describeTerminalOutcome(terminalOutcome)}`,
      );
    } finally {
      db.close();
    }
  });
});
