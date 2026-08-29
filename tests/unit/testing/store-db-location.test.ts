import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '#src/store/db.js';
import { assertTestDatabaseLocation } from '#tools/testing/store-db-location.js';

const originalTier = process.env.CORAL_TEST_TIER;

function databaseAt(location: string | null): { db: Database; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  return { db: { location: () => location, close } as unknown as Database, close };
}

afterEach(() => {
  if (originalTier === undefined) delete process.env.CORAL_TEST_TIER;
  else process.env.CORAL_TEST_TIER = originalTier;
});

describe('test database location', () => {
  it('accepts an in-memory unit handle', () => {
    process.env.CORAL_TEST_TIER = 'unit';
    const { db, close } = databaseAt(null);

    expect(() => assertTestDatabaseLocation(db)).not.toThrow();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes and rejects a file-backed unit handle with integration guidance', () => {
    process.env.CORAL_TEST_TIER = 'unit';
    const { db, close } = databaseAt('/tmp/coral-unit-store.db');

    expect(() => assertTestDatabaseLocation(db)).toThrow(
      "unit test database resolved to /tmp/coral-unit-store.db; use ':memory:' or move the case to tests/integration",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('accepts integration files under the stamped temp root', () => {
    process.env.CORAL_TEST_TIER = 'integration';
    const { db, close } = databaseAt(join(process.env.TMPDIR!, 'case', 'store.db'));

    expect(() => assertTestDatabaseLocation(db)).not.toThrow();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes and rejects integration files outside the stamped temp root', () => {
    process.env.CORAL_TEST_TIER = 'integration';
    const path = `${process.env.TMPDIR!}-outside/store.db`;
    const { db, close } = databaseAt(path);

    expect(() => assertTestDatabaseLocation(db)).toThrow(`integration test database resolved to ${path}`);
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes and rejects an unstamped tier', () => {
    delete process.env.CORAL_TEST_TIER;
    const { db, close } = databaseAt(null);

    expect(() => assertTestDatabaseLocation(db)).toThrow('CORAL_TEST_TIER=<unset>');
    expect(close).toHaveBeenCalledOnce();
  });
});
