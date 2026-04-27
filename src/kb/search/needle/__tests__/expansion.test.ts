import { describe, expect, it } from 'vitest';

import { loadExpansions } from '#src/expansion/loader.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const NEEDLE_ENTRY = {
  id: 'needle',
  version: '0.2.0',
  specifier: '#src/kb/search/needle/expansion.js',
  metadata: {
    description: 'Needle vector backend',
    onboarding: 'optional' as const,
    slot: 'kb.vector',
  },
};

const FAKE_EMBEDDER_ENTRY = {
  id: 'test-embedder',
  version: '0.0.0',
  specifier: '#tests/fakes/fake-embedder.js',
  metadata: {
    description: 'fake embedder',
    slot: 'kb.embedding',
  },
};

function disposeScopes(scopes: readonly { [Symbol.dispose](): void }[]): void {
  for (const scope of [...scopes].reverse()) {
    scope[Symbol.dispose]();
  }
}

describe('needle expansion', () => {
  it('equips needle when an embedder expansion is already bound', async () => {
    const { kb, makeHost } = createTestRuntime();
    const embedderScopes = await loadExpansions(makeHost, [FAKE_EMBEDDER_ENTRY]);

    try {
      const needleScopes = await loadExpansions(makeHost, [NEEDLE_ENTRY]);

      try {
        expect(kb.embedding.heldBy).toBe('test-embedder');
        expect(kb.vector.heldBy).toBe('needle');
        expect(kb.vector.read().consumer.id).toBe('needle');
      } finally {
        disposeScopes(needleScopes);
      }
    } finally {
      disposeScopes(embedderScopes);
    }
  });

  it('throws binding-required when no embedder expansion is bound', async () => {
    const { makeHost } = createTestRuntime();

    await expect(loadExpansions(makeHost, [NEEDLE_ENTRY])).rejects.toMatchObject({
      code: 'binding-required',
      binding: 'kb.embedding',
      requiredBy: 'needle',
    });
  });

  it('binds the kb.vector runtime binding through the host', async () => {
    const { kb, makeHost } = createTestRuntime();
    const embedderScopes = await loadExpansions(makeHost, [FAKE_EMBEDDER_ENTRY]);

    try {
      const [needleScope] = await loadExpansions(makeHost, [NEEDLE_ENTRY]);

      try {
        expect(kb.vector.heldBy).toBe('needle');
        expect(kb.vector.read().consumer.id).toBe('needle');
      } finally {
        needleScope?.[Symbol.dispose]();
      }
    } finally {
      disposeScopes(embedderScopes);
    }
  });
});
