import { describe, expect, it } from 'vitest';

import { loadExpansions } from '#src/expansion/loader.js';
import { KB_EMBEDDING_CAPABILITY, KB_VECTOR_CAPABILITY } from '#src/kb/capability/constants.js';
import type { Backed, KbRuntime } from '#src/kb/contract.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';

const NEEDLE_ENTRY = {
  id: 'needle',
  version: '0.2.0',
  specifier: '#src/engines/needle/expansion.js',
  tier: 'installed' as const,
  description: 'Needle vector backend',
  onboarding: [{ kind: 'require-binding' as const, binding: KB_EMBEDDING_CAPABILITY }],
  fills: [KB_VECTOR_CAPABILITY],
};

const FAKE_EMBEDDER_ENTRY = {
  id: 'test-embedder',
  version: '0.0.0',
  specifier: '#tests/fakes/fake-embedder.js',
  tier: 'installed' as const,
  description: 'fake embedder',
  fills: [KB_EMBEDDING_CAPABILITY],
};

function heldBy(kb: KbRuntime, name: typeof KB_EMBEDDING_CAPABILITY | typeof KB_VECTOR_CAPABILITY): string | undefined {
  return kb.capabilityRegistry.runtimeView().status(name)?.heldBy;
}

function readVector(kb: KbRuntime): Backed<VectorRetrieval> {
  return kb.capabilityRegistry.runtimeView().read<Backed<VectorRetrieval>>(KB_VECTOR_CAPABILITY);
}

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
        expect(heldBy(kb, KB_EMBEDDING_CAPABILITY)).toBe('test-embedder');
        expect(heldBy(kb, KB_VECTOR_CAPABILITY)).toBe('needle');
        expect(readVector(kb).consumer.id).toBe('needle');
      } finally {
        disposeScopes(needleScopes);
      }
    } finally {
      disposeScopes(embedderScopes);
    }
  });

  it('throws binding_required when no embedder expansion is bound', async () => {
    const { makeHost } = createTestRuntime();

    await expect(loadExpansions(makeHost, [NEEDLE_ENTRY])).rejects.toMatchObject({
      code: 'binding_required',
      context: { binding: 'kb.embedding', requiredBy: 'needle' },
    });
  });
});
