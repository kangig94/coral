import {
  createOramaBaseProjection,
  type OramaBaseProjection,
  type OramaBaseProjectionOptions,
} from '#src/engines/orama/base-projection.js';
import { createOramaFtsBacked } from '#src/engines/orama/index.js';
import { OramaSnapshotStore } from '#src/engines/orama/snapshot.js';
import type { KbRuntime } from '#src/kb/contract.js';
import { KB_FTS_CAPABILITY } from '#src/kb/capability/constants.js';
import type { Disposable } from '#src/runtime/ports.js';

function createScope(): Disposable {
  return { [Symbol.dispose]() {} };
}

export type OramaFtsBinding = {
  readonly projection: OramaBaseProjection;
  readonly snapshotStore: OramaSnapshotStore;
};

const oramaFtsScopes = new WeakMap<KbRuntime, Disposable>();

/**
 * Test helper: binds `kb.fts` to a fresh Orama projection (matching what the
 * bundled-fallback pass does in production). KbRuntime no longer constructs
 * the projection internally, so tests that exercise the FTS read path through
 * reading the kb.fts capability need this explicit bind.
 */
export function bindOramaFtsForTest(runtime: KbRuntime, options: OramaBaseProjectionOptions = {}): OramaFtsBinding {
  const previous = oramaFtsScopes.get(runtime);
  if (previous !== undefined) {
    previous[Symbol.dispose]();
  }

  const snapshotStore = new OramaSnapshotStore(
    { files: runtime.projectionArtifacts.files },
    runtime.projectionArtifacts.runtimeDir,
  );
  const projection = createOramaBaseProjection(runtime, snapshotStore, options);
  const ftsBacked = createOramaFtsBacked(projection);
  const scope = createScope();
  runtime.capabilityRegistry.runtimeView().bind(KB_FTS_CAPABILITY, ftsBacked, scope, 'orama');
  oramaFtsScopes.set(runtime, scope);
  return { projection, snapshotStore };
}
