import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { REAL_CONSUMER_DRIVER_TIMERS, realConsumerDriverNow } from '#tests/helpers/consumer-driver-defaults.js';
import type { StoragePort } from '#src/runtime/ports.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';

// Type-level claims (cursor-expansion is structurally unrepresentable through
// `ExpansionHost.registerConsumer`) live at
// tests/types/expansion-registration-unrepresentable.test-d.ts and are
// typechecked by `tsc -p tests/types/tsconfig.json` and
// `tsc -p tsconfig.test.json` during `npm test`.

const REPO_ROOT = process.cwd();

const nodeStorage: Pick<StoragePort, 'existsSync' | 'readFileSync' | 'readdirSync'> = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: readdirSync as StoragePort['readdirSync'],
};

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyStoreSchemas({ db, storage: nodeStorage });
  return db;
}

function grepFiles(roots: readonly string[], pattern: RegExp): string[] {
  const results: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !path.endsWith('.ts')) {
        continue;
      }
      const text = readFileSync(path, 'utf8');
      if (pattern.test(text)) {
        results.push(relative(REPO_ROOT, path));
      }
    }
  };

  roots.forEach((root) => visit(join(REPO_ROOT, root)));
  return results.sort();
}

describe('expansion consumer registration boundary', () => {
  it('runtime: ConsumerDriver.register still accepts cursor + expansion directly', () => {
    const db = createDb();
    const driver = new ConsumerDriver({ db, time: REAL_CONSUMER_DRIVER_TIMERS, now: realConsumerDriverNow });
    try {
      const handle = driver.register({
        id: 'cursor-expansion',
        authority: 'journal',
        kind: 'cursor',
        registrationKind: 'expansion',
      });

      expect(handle.id).toBe('cursor-expansion');
      expect(handle.registrationKind).toBe('expansion');
    } finally {
      void driver.shutdown();
      db.close();
    }
  });

  it('has no production engine declaring the forbidden cursor-expansion combination', () => {
    expect(grepFiles(['src/engines', 'src/expansion'], /\bkind:\s*['"]cursor['"]/)).toEqual([]);
    expect(grepFiles(['src/engines'], /\bregistrationKind:\s*['"]expansion['"]/)).toEqual([]);
  });
});
