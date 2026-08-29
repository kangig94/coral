import { type MockInstance, vi } from 'vitest';

import * as dbModule from '#src/store/db.js';

export function spyOnClassifyStoreFile(): MockInstance<typeof dbModule.classifyStoreFile> {
  return vi.spyOn(dbModule, 'classifyStoreFile');
}

export function spyOnOpenStoreDatabase(): MockInstance<typeof dbModule.openStoreDatabase> {
  return vi.spyOn(dbModule, 'openStoreDatabase');
}
