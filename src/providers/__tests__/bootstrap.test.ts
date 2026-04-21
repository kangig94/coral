import { describe, expect, it } from 'vitest';

import { createBuiltInProviderRegistry, registerBuiltInProviders } from '../bootstrap.js';
import type { ProviderEventBody, ProviderRuntime, ProviderSpec } from '../contract.js';
import { ProviderRegistry } from '../registry.js';
import { CORAL_SCRIPTED_PROVIDER_SPEC_ENV } from '../../testing/scripted-provider.js';

const BASE_RUNTIME: ProviderRuntime = {
  signal: new AbortController().signal,
  runCli: async () => ({ stdout: '', stderr: '', code: 0, aborted: false }),
  acquireServer: async () => {
    throw new Error('not used in bootstrap tests');
  },
  continuityBridge: {
    checkpoint: () => {},
    transportClosed: () => {},
  },
};

async function collect(stream: AsyncIterable<ProviderEventBody>): Promise<ProviderEventBody[]> {
  const events: ProviderEventBody[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

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
      [CORAL_SCRIPTED_PROVIDER_SPEC_ENV]: JSON.stringify({
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

    const events = await collect(
      registry.get('codex')!.run(
        {
          action: 'exec',
          sessionId: 'job-scripted',
          prompt: 'hello',
          cwd: process.cwd(),
          bypassPermissions: false,
          coralEnv: {},
        },
        BASE_RUNTIME,
      ),
    );

    expect(events).toEqual([
      { kind: 'progress', message: 'scripted registry progress' },
      {
        kind: 'continuity',
        conversationRef: 'scripted-registry-session',
        resumable: true,
        providerContinuity: null,
      },
      {
        kind: 'terminal',
        terminal: {
          content: 'scripted registry terminal',
          outcome: { kind: 'completed' },
        },
        diagnostics: {},
      },
    ]);
  });
});
