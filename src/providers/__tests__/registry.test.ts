import { describe, expect, it } from 'vitest';
import { registerBuiltInProviders } from '../bootstrap.js';
import { ProviderRegistry } from '../registry.js';
import type { Provider } from '../types.js';

function makeProvider(name: string): Provider {
  return {
    name,
    execute: async () => ({ content: `${name} response` }),
  };
}

function providerNames(providers: Provider[]): string[] {
  return providers.map((provider) => provider.name);
}

describe('ProviderRegistry', () => {
  it('registers and resolves providers', () => {
    const registry = new ProviderRegistry();
    const provider = makeProvider('codex-like');

    registry.register(provider);

    expect(registry.get('codex-like')).toBe(provider);
    expect(providerNames(registry.getAll())).toEqual(['codex-like']);
  });

  it('rejects reserved provider names', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.register(makeProvider('wait'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('workflow'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('abort'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('backend'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_search'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_promote'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_update'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_delete'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_reindex'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_memo'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_memo_list'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_memo_delete'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('kb_memo_purge'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('discuss_seed'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('discuss_start'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('discuss_watch'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('discuss_participate'))).toThrow('reserved');
    expect(() => registry.register(makeProvider('discuss_abort'))).toThrow('reserved');
  });

  it('rejects duplicate provider registrations', () => {
    const registry = new ProviderRegistry();

    registry.register(makeProvider('dup'));
    expect(() => registry.register(makeProvider('dup'))).toThrow('already registered');
  });

  it('preserves registration insertion order', () => {
    const registry = new ProviderRegistry();

    registry.register(makeProvider('zzz'));
    registry.register(makeProvider('aaa'));
    registry.register(makeProvider('mmm'));

    expect(providerNames(registry.getAll())).toEqual(['zzz', 'aaa', 'mmm']);
  });

  it('keeps registry state isolated per instance', () => {
    const left = new ProviderRegistry();
    const right = new ProviderRegistry();

    left.register(makeProvider('left'));
    right.register(makeProvider('right'));

    expect(providerNames(left.getAll())).toEqual(['left']);
    expect(providerNames(right.getAll())).toEqual(['right']);
  });

  it('returns empty state before any registration', () => {
    const registry = new ProviderRegistry();

    expect(registry.getAll()).toEqual([]);
    expect(registry.get('codex')).toBeUndefined();
  });
});

describe('registerBuiltInProviders', () => {
  it('registers built-in execution providers on the target registry', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);

    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });

  it('is idempotent per registry instance', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);

    expect(() => registerBuiltInProviders(registry)).not.toThrow();
    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });

  it('does not affect other registries', () => {
    const bootstrapped = new ProviderRegistry();
    const untouched = new ProviderRegistry();

    registerBuiltInProviders(bootstrapped);

    expect(providerNames(bootstrapped.getAll())).toEqual(['codex', 'claude']);
    expect(untouched.getAll()).toEqual([]);
  });

  it('fails when a conflicting provider is already registered', () => {
    const registry = new ProviderRegistry();

    registry.register(makeProvider('codex'));

    expect(() => registerBuiltInProviders(registry)).toThrow(/already registered/i);
    expect(providerNames(registry.getAll())).toEqual(['codex']);
  });

  it('clear resets registered providers and bootstrap state', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);
    registry.clear();

    expect(registry.getAll()).toEqual([]);

    registerBuiltInProviders(registry);

    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });
});
