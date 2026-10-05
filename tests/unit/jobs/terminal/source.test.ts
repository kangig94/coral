import { expect, it, vi } from 'vitest';
import type { Runtime } from '#src/runtime/ports.js';
import { withTerminalSource } from '#src/jobs/terminal/source.js';

const fixture = vi.hoisted(() => ({
  release: vi.fn(),
  close: vi.fn(),
  acquire: vi.fn(),
}));
vi.mock('#src/store/epoch/index.js', () => ({ STORE_LOCK_FILE_NAME: '.fixture-store-lock' }));
vi.mock('#src/store/epoch/observation.js', () => ({
  observeResolvedStoreEpoch: () => ({ path: '/fixture/epoch/store.db' }),
  inspectResolvedStoreEpochKey: () => 'fixture-epoch',
}));
vi.mock('#src/store/path-observation.js', () => ({ observeStorePath: () => 'present' }));
vi.mock('#src/infra/fs-lock.js', () => ({
  acquireSharedFileLockNoRepairSync: fixture.acquire,
}));

it('uses the store lock name while guarding the fingerprint-aware terminal source', () => {
  fixture.acquire.mockReturnValue(fixture.release);
  const db = { close: fixture.close };
  const runtime = { storage: { openSqliteDatabaseSync: vi.fn(() => db) } } as unknown as Runtime;
  expect(withTerminalSource(runtime, 'fixture-epoch', () => 'read')).toBe('read');
  expect(fixture.acquire).toHaveBeenCalledExactlyOnceWith('/fixture/epoch/.fixture-store-lock');
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(fixture.release).toHaveBeenCalledOnce();
});
