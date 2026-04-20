import { describe, expect, it } from 'vitest';
import { createBuiltInProviderRegistry, registerBuiltInProviders } from '../bootstrap.js';
import { collectProviderTerminalEvent, providerTerminalEvent, streamProviderTerminal } from '../protocol.js';
import { ProviderRegistry } from '../registry.js';
import type { Provider, ProviderArtifactCleanup } from '../provider-contracts.js';

function makeProvider(name: string): Provider {
  return {
    name,
    execute: () => streamProviderTerminal({ content: `${name} response`, outcome: { kind: 'completed' as const } }),
  };
}

function makeCleanupRole(name: string): ProviderArtifactCleanup {
  return {
    name,
    cleanupSessions: async () => {},
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
    expect(registry.getExecutor('codex-like')).toBe(provider);
    expect(providerNames(registry.getAll())).toEqual(['codex-like']);
  });

  it('exposes role views from the registry', () => {
    const registry = new ProviderRegistry();
    const appServerLifecycle = {
      buildServerSpec: () => ({ provider: 'claude', command: 'claude', args: [], cwd: process.cwd() }),
      interrupt: async () => {},
      probe: async () => ({ resumable: true }),
      finalizeInterrupted: () => ({}),
    };
    const artifactRecovery = {
      finalizeFromArtifacts: async () =>
        providerTerminalEvent({ content: 'recovered', outcome: { kind: 'completed' as const } }),
    };
    const artifactCleanup = makeCleanupRole('claude');
    const provider: Provider = {
      name: 'claude',
      execute: () => streamProviderTerminal({ content: 'ok', outcome: { kind: 'completed' as const } }),
      appServerLifecycle,
      artifactRecovery,
      artifactCleanup,
    };

    registry.register(provider);

    expect(registry.getExecutor('claude')).toBe(provider);
    expect(registry.getAppServerLifecycle('claude')).toBe(appServerLifecycle);
    expect(registry.getArtifactRecovery('claude')).toBe(artifactRecovery);
    expect(registry.getArtifactCleanup('claude')).toBe(artifactCleanup);
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

  it('clear resets registered providers and allows re-bootstrap', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);
    registry.clear();

    expect(registry.getAll()).toEqual([]);

    registerBuiltInProviders(registry);

    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });

  it('replaces a built-in provider when CORAL_SCRIPTED_PROVIDER_SPEC targets the same name', async () => {
    const registry = createBuiltInProviderRegistry({
      CORAL_SCRIPTED_PROVIDER_SPEC: JSON.stringify({
        name: 'codex',
        progress: [{ message: 'scripted registry progress' }],
        result: {
          content: 'scripted registry terminal',
          conversationRef: 'scripted-registry-session',
          outcome: { kind: 'completed' },
        },
      }),
    });

    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);

    const terminal = await collectProviderTerminalEvent(
      registry.getExecutor('codex')!.execute(
        {
          action: 'exec',
          sessionId: 'job-scripted',
          prompt: 'hello',
          cwd: process.cwd(),
          bypassPermissions: false,
          coralEnv: {},
        },
        {
          signal: new AbortController().signal,
          runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
        },
      ),
    );

    expect(terminal).toMatchObject({
      content: 'scripted registry terminal',
      conversationRef: 'scripted-registry-session',
      outcome: { kind: 'completed' },
    });
  });
});
