import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import type { Database } from '#src/store/db.js';
import { openKbTestStoreDb, openTestStoreDb } from '#tests/helpers/store-db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import * as storeDbLocation from '#tools/testing/store-db-location.js';

const runtime = createRealRuntime('prod');
const scratchDirectories: string[] = [];

function storePath(name: string): string {
  const root = mkdtempSync(join(resolve(process.env.TMPDIR ?? tmpdir()), 'coral-store-door-'));
  scratchDirectories.push(root);
  return join(root, name);
}

function expectUnitDoorToRejectAndClose(open: () => Database): void {
  const guard = vi.spyOn(storeDbLocation, 'assertTestDatabaseLocation');

  expect(open).toThrow(/unit test database resolved to/u);
  const db = guard.mock.calls.at(-1)?.[0];
  if (db === undefined) throw new Error('Database door did not pass its opened handle to the location guard');
  expect(db.isOpen).toBe(false);
  expect(() => db.prepare('SELECT 1')).toThrow();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('checked test database doors', () => {
  it('closes a writable openTestStoreDb handle rejected by the unit tier', () => {
    const path = storePath('writable.db');

    expectUnitDoorToRejectAndClose(() => openTestStoreDb(runtime, path));
  });

  it('closes a readonly openTestStoreDb handle rejected by the unit tier', () => {
    const path = storePath('readonly.db');
    expectUnitDoorToRejectAndClose(() => openTestStoreDb(runtime, path));
    vi.restoreAllMocks();

    expectUnitDoorToRejectAndClose(() => openTestStoreDb(runtime, path, { readonly: true }));
  });

  it('closes an openKbTestStoreDb handle rejected by the unit tier', () => {
    const path = storePath('kb.db');

    expectUnitDoorToRejectAndClose(() => openKbTestStoreDb(path));
  });

  it('closes a newRawDatabase handle rejected by the unit tier', () => {
    const path = storePath('raw.db');

    expectUnitDoorToRejectAndClose(() => newRawDatabase(path));
  });
});
