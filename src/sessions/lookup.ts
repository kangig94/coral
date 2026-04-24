import type { Runtime } from '../runtime/ports.js';
import { currentBuildFlavor } from '../infra/paths.js';
import { openBackendStoreDb } from '../store/db.js';
import { createProjectionSessionLookup } from '../store/queries/sessions.js';
import type { SessionLookup } from './lookup-contract.js';
export type { SessionLookup, SessionLookupRef } from './lookup-contract.js';

type SessionLookupRuntime = Pick<Runtime, 'storage' | 'paths'>;

export function createSessionLookup(runtime: SessionLookupRuntime): SessionLookup {
  return createProjectionSessionLookup(openBackendStoreDb(runtime, currentBuildFlavor()));
}
