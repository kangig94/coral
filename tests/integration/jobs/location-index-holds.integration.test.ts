import { it, expect } from 'vitest';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

it.each(['revision.v1.json', 'certificate.v1.json'])(
  'keeps a hold durable when %s cannot be read during startup',
  (record) => {
    const f = createTerminalExportFixture('provider', true);
    try {
      const gone = JSON.stringify({
        storeRoot: '/nonexistent/db',
        epoch: '9',
        path: '/nonexistent/db/epoch-9/store.db',
        lineageKey: '00000000-0000-4000-8000-000000000000:9',
      });
      f.index.holdUnknownLocations(gone, 'Retained source cannot be observed; probe 1 of 3 failed', true);
      const dirs = readdirSync(join(f.root, 'job-locations.v1', 'epochs'));
      for (const d of dirs) {
        const p = join(f.root, 'job-locations.v1', 'epochs', d, record);
        writeFileSync(p, '{"version":"v1","epochKey');
      }
      f.index.holdUnknownLocations('healthy-absent-epoch', 'healthy hold', true);
      let thrown: unknown;
      try {
        f.index.reconcileUnknownLocationHolds([f.epochKey], true);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(f.index.unknownLocationHolds()).toHaveLength(1);
      expect(f.index.unknownLocationHold('healthy-absent-epoch')).toBeNull();
    } finally {
      f.close();
    }
  },
);
