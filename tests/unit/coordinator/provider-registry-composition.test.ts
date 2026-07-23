import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as CoordinatorCompositionModule from '#src/coordinator/composition/index.js';

vi.mock('#src/coordinator/composition/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CoordinatorCompositionModule>();
  return { ...actual, createCoordinatorCore: vi.fn(actual.createCoordinatorCore) };
});

import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { none } from '#src/providers/capability.js';
import { defineProvider } from '#src/providers/registry.js';
import { createRealRuntime } from '#src/runtime/real.js';
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

    createCoordinatorServer({
      runtime: createRealRuntime('prod'),
      pluginRoot,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      recoverPersistedDiscussFn: async () => [],
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });

    const compositionCall = vi.mocked(createCoordinatorCore).mock.calls.at(-1);
    const registry = compositionCall?.[0].providerRegistry;
    if (registry === undefined) throw new Error('Coordinator composition was not invoked.');
    expect(compositionCall?.[0].storeFormat).toBe(currentCoralStoreFormat());
    expect(registry?.getAll().map((provider) => provider.name)).toEqual(['codex', 'claude']);
    expect(registry.sealPersistedCodecComponents().map((entry) => entry.name)).toEqual([
      'provider.binding-envelope',
      'provider.codex.profile',
      'provider.codex.binding',
      'provider.codex.continuity',
      'provider.claude.profile',
      'provider.claude.binding',
      'provider.claude.continuity',
    ]);
    expect(() =>
      registry.register(
        defineProvider({
          name: 'late',
          transport: 'standalone',
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
