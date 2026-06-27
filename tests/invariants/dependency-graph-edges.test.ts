import { describe, expect, it, vi } from 'vitest';

import { ExpansionLifecycleService } from '#src/kb-daemon/expansion/lifecycle.js';
import type { ExpansionStateRow, ExpansionStateStore } from '#src/kb-daemon/expansion/state.js';
import { createExpansionManifestCatalog } from '#src/expansion/manifest/catalog.js';
import { initializeCapabilityCatalog } from '#src/expansion/manifest/fills-validation.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
} from '#src/kb/capability/constants.js';
import type { RetrievalRole } from '#src/kb/search/contract.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';
import {
  DUMMY_CACHE_CAPABILITY,
  dummyCapabilityProviderManifest,
} from '#tests/fixtures/dummy-capability-engine/manifest.js';

const FIXED_NOW = '2026-05-03T00:00:00.000Z';

function createMemoryState(): Pick<ExpansionStateStore, 'insert' | 'delete' | 'list' | 'get'> {
  const rows = new Map<string, ExpansionStateRow>();
  return {
    insert: vi.fn((row: ExpansionStateRow) => {
      rows.set(row.id, row);
    }),
    delete: vi.fn((id: string) => {
      rows.delete(id);
    }),
    list: vi.fn(() => [...rows.values()]),
    get: vi.fn((id: string) => rows.get(id)),
  };
}

describe('capability dependency graph edges', () => {
  it('uses manifest declarations only and never harvests runtime roleRegistry requires as blockers', async () => {
    const { kb, makeHost } = createTestRuntime();
    const manifestCatalog = createExpansionManifestCatalog({ staticManifests: [] });
    manifestCatalog.upsertInstalledEntry(dummyCapabilityProviderManifest);
    initializeCapabilityCatalog(kb.capabilityRegistry, manifestCatalog.listManifests(), [
      BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
      BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
      BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
    ]);
    const lifecycle = new ExpansionLifecycleService({
      makeHost,
      state: createMemoryState() as unknown as ExpansionStateStore,
      manifestCatalog,
      now: () => FIXED_NOW,
      resolveKbRuntime: () => kb,
    });
    const runtimeOnlyRole: RetrievalRole = {
      id: 'runtime-only-role',
      descriptor: {
        id: 'runtime-only-role',
        label: 'Runtime Only Role',
        tags: ['semantic'],
        phase: 'retrieval-source',
        supportsScopes: ['notes', 'sources', 'all'],
        requires: [DUMMY_CACHE_CAPABILITY],
        provides: 'retrieval-source',
      },
      async search() {
        return { hits: [] };
      },
    };

    kb.roleRegistry.registerBuiltin(runtimeOnlyRole, { criticality: 'core' });

    await lifecycle.equip('dummy-capability-provider');

    await expect(lifecycle.removeExpansionCatalog('dummy-capability-provider')).resolves.toEqual({ status: 'removed' });
    expect(kb.capabilityRegistry.catalogView().hasDescriptor(DUMMY_CACHE_CAPABILITY)).toBe(false);
  });
});
