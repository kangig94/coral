import { describe, expect, it } from 'vitest';

import { loadBundledEngine } from '#src/expansion/bundled.js';
import { createScope } from '#src/infra/disposable-scope.js';
import { KB_EMBEDDING_CAPABILITY } from '#src/kb/capability/constants.js';
import { createTestRuntime } from '#tests/fixtures/test-runtime.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';

const GEMINI_ENTRY = {
  id: 'gemini',
  version: '0.5.2',
  specifier: '#src/engines/gemini/expansion.js',
  tier: 'installed' as const,
  description: 'Google Gemini embedding API',
  fills: [KB_EMBEDDING_CAPABILITY],
};

describe('gemini expansion', () => {
  it('throws when GEMINI_API_KEY is missing', async () => {
    const { makeHost } = createTestRuntime({ runtime: new SimulationRuntime() });
    const scope = createScope();
    const host = makeHost(GEMINI_ENTRY, scope);

    await expect(loadBundledEngine(GEMINI_ENTRY, host)).rejects.toMatchObject({
      code: 'gemini-api-key-missing',
      context: { env: 'GEMINI_API_KEY', expansion: 'gemini' },
    });
  });
});
