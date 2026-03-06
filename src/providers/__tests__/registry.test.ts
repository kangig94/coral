import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetNewProvidersForTests,
  getAllNewProviders,
  getNewProvider,
  registerNewProvider,
} from '../registry.js';
import {
  _resetProviderBootstrapForTests,
  registerBuiltInProviders,
} from '../bootstrap.js';
import type { Provider } from '../types.js';

function makeProvider(name: string): Provider {
  return {
    name,
    capabilities: { resumable: true, forkable: true },
    execute: async () => ({ text: `${name} response` }),
  };
}

function resetRegistry(): void {
  _resetNewProvidersForTests();
}

function resetBootstrap(): void {
  _resetProviderBootstrapForTests();
}

function providerNames(): string[] {
  return getAllNewProviders().map((provider) => provider.name);
}

describe('providers registry', () => {
  beforeEach(resetRegistry);
  afterEach(resetRegistry);

  it('registers and resolves providers', () => {
    const provider = makeProvider('codex-like');
    registerNewProvider(provider);

    expect(getNewProvider('codex-like')).toBe(provider);
    expect(providerNames()).toEqual(['codex-like']);
  });

  it('rejects reserved provider names', () => {
    expect(() => registerNewProvider(makeProvider('wait'))).toThrow('reserved');
    expect(() => registerNewProvider(makeProvider('workflow'))).toThrow('reserved');
    expect(() => registerNewProvider(makeProvider('abort'))).toThrow('reserved');
  });

  it('rejects duplicate provider registrations', () => {
    registerNewProvider(makeProvider('dup'));
    expect(() => registerNewProvider(makeProvider('dup'))).toThrow('already registered');
  });

  it('preserves registration insertion order', () => {
    registerNewProvider(makeProvider('zzz'));
    registerNewProvider(makeProvider('aaa'));
    registerNewProvider(makeProvider('mmm'));

    expect(providerNames()).toEqual(['zzz', 'aaa', 'mmm']);
  });

  it('returns empty state before any registration', () => {
    expect(getAllNewProviders()).toEqual([]);
    expect(getNewProvider('codex')).toBeUndefined();
  });
});

describe('provider bootstrap', () => {
  beforeEach(resetBootstrap);
  afterEach(resetBootstrap);

  it('registers built-in execution providers once', () => {
    registerBuiltInProviders();

    expect(providerNames()).toEqual(['codex', 'claude']);
  });

  it('is idempotent across repeated calls', () => {
    registerBuiltInProviders();
    expect(() => registerBuiltInProviders()).not.toThrow();
    expect(providerNames()).toEqual(['codex', 'claude']);
  });

  it('fails when a conflicting provider is already registered', () => {
    registerNewProvider(makeProvider('codex'));

    expect(() => registerBuiltInProviders()).toThrow(/already registered/i);
    expect(providerNames()).toEqual(['codex']);
  });
});
