import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

let mockCoreFragment = '';

const mockStorage = {
  readFileSync: vi.fn((path: string, _encoding: 'utf-8') => {
    if (path.endsWith('/inject/core.md')) return mockCoreFragment;
    if (path.endsWith('/inject/tools.md')) return '';
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
    sessionId: 's-1',
    prompt: 'task',
    cwd: fixtureCanonicalWorkDir('/tmp'),
    bypassPermissions: false,
    coralEnv: {},
  };

  function runtime(overrides: Record<string, unknown> = {}) {
    return { storage: mockStorage, ...overrides };
  }

  it('prepends inject and preserves caller systemPrompt (append-merge, never overwrite)', async () => {
    mockCoreFragment = 'guidelines';
    const applyInjectBundle = await loadApply();
    const result = applyInjectBundle({ ...baseRequest, systemPrompt: 'caller system' }, runtime());
    expect(result.systemPrompt).toBe('guidelines\n\ncaller system');
  });
});
