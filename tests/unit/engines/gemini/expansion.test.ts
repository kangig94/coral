import { describe, expect, it } from 'vitest';

import { loadExpansions } from '#src/expansion/loader.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const GEMINI_ENTRY = {
  id: 'gemini',
  version: '0.5.2',
  specifier: '#src/engines/gemini/expansion.js',
  metadata: {
    description: 'Google Gemini embedding API',
    onboarding: 'required' as const,
    slot: 'kb.embedding',
  },
};

describe('gemini expansion', () => {
  it('equips and binds kb.embedding with a stateless consumer', async () => {
    const runtime = new SimulationRuntime({
      env: {
        GEMINI_API_KEY: 'test-gemini-key',
      },
    });
    const { kb, makeHost } = createTestRuntime({ runtime });
    const [scope] = await loadExpansions(makeHost, [GEMINI_ENTRY]);

    try {
      expect(kb.embedding.heldBy).toBe('gemini');
      expect(kb.embedding.read().consumer).toMatchObject({
        id: 'gemini',
        authority: 'journal',
        registrationKind: 'stateless',
      });
      expect(kb.embedding.read().read()).toMatchObject({
        name: 'gemini',
        model: 'gemini-embedding-001',
        dims: 3072,
        normalization: 'l2',
      });
    } finally {
      scope?.[Symbol.dispose]();
    }
  });

  it('throws when GEMINI_API_KEY is missing', async () => {
    const { makeHost } = createTestRuntime({ runtime: new SimulationRuntime() });

    await expect(loadExpansions(makeHost, [GEMINI_ENTRY])).rejects.toMatchObject({
      code: 'gemini-api-key-missing',
      context: { env: 'GEMINI_API_KEY', expansion: 'gemini' },
    });
  });
});
