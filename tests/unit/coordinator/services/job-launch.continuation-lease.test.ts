import { describe, expect, it, vi } from 'vitest';

import { none } from '#src/providers/capability.js';
import { defineProvider } from '#src/providers/define.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import { JobLaunchService } from '#src/coordinator/services/job-launch.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_CODEX_SOURCE, TEST_PROVIDER_CREDENTIALS } from '#tests/helpers/provider-credentials.js';

const ctx: InvocationContext = {
  projectRoot: '/tmp/coral-project',
  pluginRoot: '/tmp/coral-plugin',
  coralEnv: {},
  principal: testProjectPrincipal('/tmp/coral-project'),
  providerCredentials: TEST_PROVIDER_CREDENTIALS,
};

function sessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: 'session-retention-lock',
    provider: 'codex',
    sessionAuthority: { kind: 'provider', source: TEST_CODEX_SOURCE },
    name: 'session-retention-lock',
    state: 'ready',
    retention: 'discard_provider_artifacts_on_terminal',
    artifactHandles: [],
    retentionDiscard: {
      attempts: [
        {
          attempt: 1,
          handles: [],
          status: 'requested',
        },
      ],
    },
    cwd: '/tmp/coral-project',
    projectRoot: '/tmp/coral-project',
    backendNamespace: 'test-ns',
    providerContinuity: null,
    conversationRef: 'thread-1',
    createdAt: '2026-06-23T00:00:00.000Z',
    lastUsedAt: '2026-06-23T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

describe('JobLaunchService continuation lease admission', () => {
  it('rejects resume when retention discard request is in flight', async () => {
    const runtime = new SimulationRuntime();
    const launchOrchestrator = {
      claimAndAdmitJob: vi.fn(),
      launchProviderJob: vi.fn(),
    };
    const provider = defineProvider({ name: 'codex', run: async function* noopProvider() {} })
      .artifacts(none('test provider has no artifacts'))
      .build();
    const service = new JobLaunchService({
      runtime,
      childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
      sessionManager: {
        allocate: vi.fn(),
        get: vi.fn(() => sessionEntry()),
        list: vi.fn(() => []),
        releaseJob: vi.fn(),
        claimForJobAtomic: vi.fn(),
        recordContinuationLease: vi.fn(),
        claimContinuationLease: vi.fn(),
        clearContinuationLease: vi.fn(),
      },
      backendNamespace: 'test-ns',
      bundleHash: 'test-bundle',
      providerRegistry: {
        get: vi.fn(() => provider),
        getAll: vi.fn(() => [provider]),
      },
      pluginRegistry: { discoverPluginRoot: vi.fn(() => null) },
      progressStore: {} as never,
      launchOrchestrator: launchOrchestrator as never,
    });

    await expect(
      service.resume('codex', { sessionId: 'session-retention-lock', prompt: 'continue' }, ctx),
    ).resolves.toMatchObject({
      status: 'rejected',
      code: 'retention_discard_in_flight',
    });
    expect(launchOrchestrator.claimAndAdmitJob).not.toHaveBeenCalled();
    expect(launchOrchestrator.launchProviderJob).not.toHaveBeenCalled();
  });
});
