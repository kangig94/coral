import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CoordinatorCompositionModule from '#src/coordinator/composition/index.js';
import type * as CurrentFormatModule from '#src/store/current-format.js';

vi.mock('#src/store/current-format.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CurrentFormatModule>();
  return { ...actual, assertCurrentStoreFormat: vi.fn(actual.assertCurrentStoreFormat) };
});

vi.mock('#src/coordinator/composition/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CoordinatorCompositionModule>();
  return { ...actual, createCoordinatorCore: vi.fn(actual.createCoordinatorCore) };
});

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import { none } from '#src/providers/capability.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { assertCurrentStoreFormat } from '#src/store/current-format.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { prepareFixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('coordinator provider registry composition', () => {
  it('registers, fingerprints, seals, and retains one registry authority', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-provider-registry-home-'));
    const pluginRoot = mkdtempSync(join(tmpdir(), 'coral-provider-registry-plugin-'));
    roots.push(home, pluginRoot);
    mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'provider-registry-composition', flavor: 'prod' }) + '\n',
      'utf-8',
    );
    vi.stubEnv('HOME', home);

    const registry = new ProviderRegistry();
    const register = vi.fn((received: ProviderRegistry) => {
      expect(received).toBe(registry);
      received.register(
        defineProvider({
          name: 'fixture',
          run: async function* () {},
          prepareExecutionPlan: prepareFixtureExecutionPlan,
        })
          .binding(fixtureProviderBindingCodec('fixture'))
          .artifacts(none('fixture'))
          .build(),
      );
    });

    createCoordinatorServer({
      runtime: createRealRuntime('prod'),
      pluginRoot,
      providerRegistry: registry,
      registerBuiltInProvidersFn: register,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });

    expect(register).toHaveBeenCalledTimes(1);
    const formatCall = vi.mocked(assertCurrentStoreFormat).mock.calls.at(-1);
    expect(formatCall?.[3]?.map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.fixture.binding',
    ]);
    const compositionCall = vi.mocked(createCoordinatorCore).mock.calls.at(-1);
    expect(compositionCall?.[0].providerRegistry).toBe(registry);
    expect(registry.get('fixture')?.name).toBe('fixture');
    expect(registry.sealPersistedBindingCodecComponents().map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.fixture.binding',
    ]);
    expect(() =>
      registry.register(
        defineProvider({
          name: 'late',
          run: async function* () {},
          prepareExecutionPlan: prepareFixtureExecutionPlan,
        })
          .binding(fixtureProviderBindingCodec('late'))
          .artifacts(none('late'))
          .build(),
      ),
    ).toThrow("registry is sealed; cannot register 'late'");
  });
});
