import { describe, expect, it } from 'vitest';

import type { ProviderSpec } from '../contract.js';
import { ProviderRegistry } from '../registry.js';

function makeSpec(name: string, overrides: Partial<ProviderSpec> = {}): ProviderSpec {
  return {
    name,
    run: async function* () {
      yield {
        kind: 'terminal',
        terminal: {
          content: `${name} response`,
          outcome: { kind: 'completed' as const },
        },
        diagnostics: {},
      };
    },
    ...overrides,
  };
}

function providerNames(providers: ProviderSpec[]): string[] {
  return providers.map((provider) => provider.name);
}

describe('ProviderRegistry', () => {
  it('registers and resolves provider specs', () => {
    const registry = new ProviderRegistry();
    const spec = makeSpec('codex-like');

    registry.register(spec);

    expect(registry.get('codex-like')).toBe(spec);
    expect(providerNames(registry.getAll())).toEqual(['codex-like']);
  });

  it('surfaces optional facets as undefined when absent', () => {
    const registry = new ProviderRegistry();
    const spec = makeSpec('claude');

    registry.register(spec);

    expect(registry.get('claude')?.appServer).toBeUndefined();
    expect(registry.get('claude')?.recovery).toBeUndefined();
    expect(registry.get('claude')?.cleanup).toBeUndefined();
  });

  it('retains registered facets on the spec', () => {
    const registry = new ProviderRegistry();
    const appServer = {
      name: 'claude',
      subscriptionPhase: 'beforeInitialize' as const,
      buildServerSpec: () => ({ provider: 'claude', command: 'claude', args: [], cwd: process.cwd() }),
      interrupt: async () => {},
    };
    const recovery = {
      probe: async () => ({ resumable: true }),
      finalizeInterrupted: () => ({ type: 'preserve' as const }),
      finalizeFromArtifacts: async () => ({
        terminal: {
          kind: 'terminal' as const,
          terminal: {
            content: 'recovered',
            outcome: { kind: 'completed' as const },
          },
          diagnostics: {},
        },
      }),
    };
    const cleanup = {
      name: 'claude',
      cleanupSessions: async () => {},
    };
    const spec = makeSpec('claude', { appServer, recovery, cleanup });

    registry.register(spec);

    expect(registry.get('claude')?.appServer).toBe(appServer);
    expect(registry.get('claude')?.recovery).toBe(recovery);
    expect(registry.get('claude')?.cleanup).toBe(cleanup);
  });

  it('rejects reserved provider names', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.register(makeSpec('wait'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('workflow'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('abort'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('backend'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_search'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_promote'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_update'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_delete'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_reindex'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo_list'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo_delete'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('kb_memo_purge'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_seed'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_start'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_watch'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_participate'))).toThrow('reserved');
    expect(() => registry.register(makeSpec('discuss_abort'))).toThrow('reserved');
  });

  it('rejects duplicate provider registrations', () => {
    const registry = new ProviderRegistry();

    registry.register(makeSpec('dup'));
    expect(() => registry.register(makeSpec('dup'))).toThrow('already registered');
  });

  it('preserves registration insertion order', () => {
    const registry = new ProviderRegistry();

    registry.register(makeSpec('zzz'));
    registry.register(makeSpec('aaa'));
    registry.register(makeSpec('mmm'));

    expect(providerNames(registry.getAll())).toEqual(['zzz', 'aaa', 'mmm']);
  });

  it('keeps registry state isolated per instance', () => {
    const left = new ProviderRegistry();
    const right = new ProviderRegistry();

    left.register(makeSpec('left'));
    right.register(makeSpec('right'));

    expect(providerNames(left.getAll())).toEqual(['left']);
    expect(providerNames(right.getAll())).toEqual(['right']);
  });

  it('returns empty state before any registration', () => {
    const registry = new ProviderRegistry();

    expect(registry.getAll()).toEqual([]);
    expect(registry.get('codex')).toBeUndefined();
  });

  it('clear resets registered providers', () => {
    const registry = new ProviderRegistry();
    registry.register(makeSpec('codex'));

    registry.clear();

    expect(registry.getAll()).toEqual([]);
  });
});
