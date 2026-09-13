import { type MockInstance, vi } from 'vitest';

import * as dbModule from '#src/store/db.js';

export function spyOnClassifyStoreFile(): MockInstance<typeof dbModule.classifyStoreFile> {
  return vi.spyOn(dbModule, 'classifyStoreFile');
}

export function spyOnOpenWritableStoreDatabase(): MockInstance<typeof dbModule.openWritableStoreDatabase> {
  return vi.spyOn(dbModule, 'openWritableStoreDatabase');
}
