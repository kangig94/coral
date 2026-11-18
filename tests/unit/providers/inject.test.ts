import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

let mockCoreFragment = '';
const providerAgentFragment = readFileSync(
  new URL('../../../clients/inject/provider-agent.md', import.meta.url),
  'utf8',
).trimEnd();

const mockStorage = {
  readFileSync: vi.fn((path: string, _encoding: 'utf-8') => {
    if (path.endsWith('/inject/core.md')) return mockCoreFragment;
    if (path.endsWith('/inject/tools.md')) return '';
    if (path.endsWith('/inject/provider-agent.md')) return providerAgentFragment;
    throw new Error(`unexpected read: ${path}`);
  }),
};

beforeEach(() => {
  mockCoreFragment = '';
  mockStorage.readFileSync.mockClear();
  // Source modules use the esbuild-injected bare identifier `__PLUGIN_ROOT__`.
  // Vitest has no esbuild define for it — mirror the setup global onto the free name.
  vi.stubGlobal('__PLUGIN_ROOT__', process.cwd());
});

async function loadApply() {
  const mod = await import('#src/providers/inject.js');
  return mod.applyInjectBundle;
}

describe('applyInjectBundle', () => {
  const baseRequest = {
    action: 'exec' as const,
    jobId: 's-1',
    prompt: 'task',
    cwd: fixtureCanonicalWorkDir('/tmp'),
    bypassPermissions: false,
    coralEnv: {},
  };

  function runtime(overrides: Record<string, unknown> = {}) {
    return { storage: mockStorage, ...overrides };
  }

  it('prepends provider guidance and preserves the caller system prompt', async () => {
    mockCoreFragment = 'guidelines';
    const applyInjectBundle = await loadApply();
    const result = applyInjectBundle({ ...baseRequest, systemPrompt: 'caller system' }, runtime());
    expect(result.systemPrompt).toBe(`guidelines\n\n${providerAgentFragment}\n\ncaller system`);
  });
});
