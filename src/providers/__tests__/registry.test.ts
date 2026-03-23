import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '../types.js';

function makeProvider(name: string): Provider {
  return {
    name,
    execute: async () => ({ content: `${name} response` }),
  };
}

async function loadProviderModules() {
  vi.resetModules();
  const [registry, bootstrap] = await Promise.all([
    import('../registry.js'),
    import('../bootstrap.js'),
  ]);
  return { registry, bootstrap };
}

function providerNames(providers: Provider[]): string[] {
  return providers.map((provider) => provider.name);
}

describe('providers registry', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('registers and resolves providers', async () => {
    const { registry } = await loadProviderModules();
    const provider = makeProvider('codex-like');

    registry.registerNewProvider(provider);

    expect(registry.getNewProvider('codex-like')).toBe(provider);
    expect(providerNames(registry.getAllNewProviders())).toEqual(['codex-like']);
  });

  it('rejects reserved provider names', async () => {
    const { registry } = await loadProviderModules();

    expect(() => registry.registerNewProvider(makeProvider('wait'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('workflow'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('abort'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('backend'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('kb_search'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('kb_promote'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('kb_update'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('kb_delete'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('kb_reindex'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('discuss_seed'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('discuss_start'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('discuss_watch'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('discuss_participate'))).toThrow('reserved');
    expect(() => registry.registerNewProvider(makeProvider('discuss_abort'))).toThrow('reserved');
  });

  it('rejects duplicate provider registrations', async () => {
    const { registry } = await loadProviderModules();

    registry.registerNewProvider(makeProvider('dup'));
    expect(() => registry.registerNewProvider(makeProvider('dup'))).toThrow('already registered');
  });

  it('preserves registration insertion order', async () => {
    const { registry } = await loadProviderModules();

    registry.registerNewProvider(makeProvider('zzz'));
    registry.registerNewProvider(makeProvider('aaa'));
    registry.registerNewProvider(makeProvider('mmm'));

    expect(providerNames(registry.getAllNewProviders())).toEqual(['zzz', 'aaa', 'mmm']);
  });

  it('returns empty state before any registration', async () => {
    const { registry } = await loadProviderModules();

    expect(registry.getAllNewProviders()).toEqual([]);
    expect(registry.getNewProvider('codex')).toBeUndefined();
  });
});

describe('provider bootstrap', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('registers built-in execution providers once', async () => {
    const { registry, bootstrap } = await loadProviderModules();

    bootstrap.registerBuiltInProviders();

    expect(providerNames(registry.getAllNewProviders())).toEqual(['codex', 'claude']);
  });

  it('is idempotent across repeated calls', async () => {
    const { registry, bootstrap } = await loadProviderModules();

    bootstrap.registerBuiltInProviders();

    expect(() => bootstrap.registerBuiltInProviders()).not.toThrow();
    expect(providerNames(registry.getAllNewProviders())).toEqual(['codex', 'claude']);
  });

  it('fails when a conflicting provider is already registered', async () => {
    const { registry, bootstrap } = await loadProviderModules();

    registry.registerNewProvider(makeProvider('codex'));

    expect(() => bootstrap.registerBuiltInProviders()).toThrow(/already registered/i);
    expect(providerNames(registry.getAllNewProviders())).toEqual(['codex']);
  });
});
