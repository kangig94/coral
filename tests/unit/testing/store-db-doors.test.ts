import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStoreServicesRef,
  type CoordinatorStoreServices,
} from '#src/coordinator/composition/store-services-ref.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Database } from '#src/store/db.js';
import { openKbTestStoreDb, openTestStoreDb } from '#tests/helpers/store-db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import * as storeDbLocation from '#tools/testing/store-db-location.js';
import { setStoreServicesForTest } from '#tools/testing/store-services.js';

const runtime = createRealRuntime('prod');
const scratchDirectories: string[] = [];

function storePath(name: string): string {
  const root = mkdtempSync(join(resolve(process.env.TMPDIR ?? tmpdir()), 'coral-store-door-'));
  scratchDirectories.push(root);
  return join(root, name);
}

function expectUnitDoorToRejectAndClose(open: () => Database): void {
  const guard = vi.spyOn(storeDbLocation, 'assertTestDatabaseLocation');
  const outcome = (() => {
    try {
      return { kind: 'returned' as const, db: open() };
    } catch (error: unknown) {
      return { kind: 'threw' as const, error };
    }
  })();
  const db = outcome.kind === 'returned' ? outcome.db : guard.mock.calls.at(-1)?.[0];

  try {
    expect(() => {
      if (outcome.kind === 'threw') throw outcome.error;
    }).toThrow(/unit test database resolved to/u);
    expect(db).toBeDefined();
    if (db === undefined) return;
    expect(db.isOpen).toBe(false);
    expect(() => db.prepare('SELECT 1')).toThrow();
  } finally {
    if (db?.isOpen === true) db.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('closes a real handle when the test tier is unrecognized', () => {
    const path = storePath('unknown-tier.db');
    vi.stubGlobal(Symbol.for('coral.testing.enforced-test-location-policy'), {
      tier: 'unexpected',
      tempRoot: resolve(process.env.TMPDIR ?? tmpdir()),
    });
    const guard = vi.spyOn(storeDbLocation, 'assertTestDatabaseLocation');

    let db: Database | undefined;
    try {
      expect(() => newRawDatabase(path)).toThrow(/CORAL_TEST_TIER=unexpected/u);
      db = guard.mock.calls.at(-1)?.[0];
      expect(db).toBeDefined();
      expect(db?.isOpen).toBe(false);
      expect(() => db?.prepare('SELECT 1')).toThrow();
    } finally {
      if (db?.isOpen === true) db.close();
    }
  });

  it('closes and refuses store services backed by a file under the unit tier', () => {
    const path = storePath('services.db');
    const bypass = vi.spyOn(storeDbLocation, 'assertTestDatabaseLocation').mockImplementationOnce(() => undefined);
    const db = (() => {
      try {
        return newRawDatabase(path);
      } finally {
        bypass.mockRestore();
      }
    })();
    const ref = createStoreServicesRef();
    const services = { storeDb: db } as CoordinatorStoreServices;

    try {
      expect(() => setStoreServicesForTest(ref, services)).toThrow(/unit test database resolved to/u);
      expect(db.isOpen).toBe(false);
      expect(ref.tryGet()).toBeNull();
    } finally {
      if (db.isOpen) db.close();
    }
  });
});
