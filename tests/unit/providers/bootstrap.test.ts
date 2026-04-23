import { describe, expect, it } from 'vitest';

import { createBuiltInProviderRegistry, registerBuiltInProviders } from '#src/providers/bootstrap.js';
import type { ProviderSpec } from '#src/providers/contract.js';
import { ProviderRegistry } from '#src/providers/registry.js';

function providerNames(providers: ProviderSpec[]): string[] {
  return providers.map((provider) => provider.name);
}

describe('registerBuiltInProviders', () => {
  it('registers claude and codex provider specs', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);

    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });

  it('registers the expected facet set for built-in providers', () => {
    const registry = createBuiltInProviderRegistry();
    const claude = registry.get('claude');
    const codex = registry.get('codex');

    expect(claude).toBeDefined();
    expect(typeof claude?.run).toBe('function');
    expect(claude?.appServer).toMatchObject({
      name: 'claude',
      subscriptionPhase: 'beforeInitialize',
    });
    expect(typeof claude?.appServer?.buildServerSpec).toBe('function');
    expect(typeof claude?.appServer?.interrupt).toBe('function');
    expect(typeof claude?.recovery?.probe).toBe('function');
    expect(typeof claude?.recovery?.finalizeInterrupted).toBe('function');
    expect(typeof claude?.recovery?.finalizeFromArtifacts).toBe('function');
    expect(typeof claude?.cleanup?.cleanupSessions).toBe('function');

    expect(codex).toBeDefined();
    expect(typeof codex?.run).toBe('function');
    expect(codex?.appServer).toMatchObject({
      name: 'codex',
      subscriptionPhase: 'afterInitialize',
    });
    expect(typeof codex?.appServer?.buildServerSpec).toBe('function');
    expect(typeof codex?.appServer?.interrupt).toBe('function');
    expect(typeof codex?.recovery?.probe).toBe('function');
    expect(typeof codex?.recovery?.finalizeInterrupted).toBe('function');
    expect(typeof codex?.recovery?.finalizeFromArtifacts).toBe('function');
  });

  it('is idempotent per registry instance', () => {
    const registry = new ProviderRegistry();

    registerBuiltInProviders(registry);

    expect(() => registerBuiltInProviders(registry)).not.toThrow();
    expect(providerNames(registry.getAll())).toEqual(['codex', 'claude']);
  });

  it('fails when a conflicting provider is already registered', () => {
    const registry = new ProviderRegistry();

    registry.register({
      name: 'codex',
      run: async function* () {
        yield {
          kind: 'terminal',
          terminal: {
            content: 'conflict',
            outcome: { kind: 'completed' as const },
          },
          diagnostics: {},
        };
      },
    });

    expect(() => registerBuiltInProviders(registry)).toThrow(/already registered/i);
  });
});
