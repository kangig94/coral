import { describe, expect, it, vi } from 'vitest';

import { none } from '#src/providers/capability.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobConversation } from '#src/jobs/conversation/entry.js';
import { JobLaunchService } from '#src/coordinator/services/job-launch.js';
import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_CODEX_BINDING, TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { prepareFixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const ctx: InvocationContext = {
  projectRoot: fixtureCanonicalWorkDir('/tmp/coral-project'),
  pluginRoot: '/tmp/coral-plugin',
  coralEnv: {},
  principal: testProjectPrincipal('/tmp/coral-project'),
  providerScope: TEST_CODEX_SCOPE,
};

function sessionEntry(overrides: Partial<JobConversation> = {}): JobConversation {
  return {
    jobId: '10000000-0000-4000-8000-000000000001',
    provider: 'codex',
    execution: 1,
    open: false,
    finishing: false,
    bypassPermissions: false,
    binding: TEST_CODEX_BINDING,
    name: 'session-retention-lock',
    retention: 'discard_provider_artifacts_on_terminal',
    artifactHandles: [],
    retentionDiscard: {
      attempts: [
        {
          execution: 1,
          attempt: 1,
          handles: [],
          status: 'requested',
        },
      ],
    },
    cwd: fixtureCanonicalWorkDir('/tmp/coral-project'),
    projectRoot: '/tmp/coral-project',
    backendNamespace: 'test-ns',
    providerContinuity: null,
    conversationRef: 'thread-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    lastUsedAt: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('JobLaunchService continuation retention admission', () => {
  it('rejects resume when retention discard request is in flight', async () => {
    const runtime = new SimulationRuntime();
    const launchOrchestrator = {
      launchExecution: vi.fn(),
    };
    const provider = defineProvider({
      name: 'codex',
      transport: 'standalone',
      run: async function* noopProvider() {},
      prepareExecutionPlan: prepareFixtureExecutionPlan,
    })
      .binding(fixtureProviderBindingCodec('codex'))
      .artifacts(none('test provider has no artifacts'))
      .build();
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(provider);
    const service = new JobLaunchService({
      runtime,
      childPrincipalRegistry: testChildPrincipalRegistry(runtime.ids),
      conversationManager: {
        prepare: vi.fn(),
        readById: vi.fn(),
        get: vi.fn(() => sessionEntry()),
        list: vi.fn(() => []),
      },
      backendNamespace: 'test-ns',
      bundleHash: 'test-bundle',
      providerRegistry,
      pluginRegistry: { discoverPluginRoot: vi.fn(() => null) },
      progressStore: {} as never,
      launchOrchestrator: launchOrchestrator as never,
    });

    await expect(
      service.resume('codex', { jobId: '10000000-0000-4000-8000-000000000001', prompt: 'continue' }, ctx),
    ).resolves.toMatchObject({
      status: 'refused',
      code: 'retention_discard_in_flight',
    });
    expect(launchOrchestrator.launchExecution).not.toHaveBeenCalled();
  });
});
