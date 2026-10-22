import { describe, expect, it, vi } from 'vitest';

import { none } from '#src/providers/capability.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import type { JobConversation } from '#src/jobs/conversation/entry.js';
import { JobLaunchService } from '#src/coordinator/services/job-launch.js';
import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { TEST_CODEX_BINDING, TEST_CODEX_SCOPE, withTestProfileLocation } from '#tests/helpers/provider-credentials.js';
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

function fixture(entry: JobConversation = sessionEntry()) {
  const runtime = new SimulationRuntime();
  const launchOrchestrator = { launchExecution: vi.fn() };
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
      get: vi.fn(() => entry),
      list: vi.fn(() => []),
    },
    backendNamespace: 'test-ns',
    bundleHash: 'test-bundle',
    providerRegistry,
    pluginRegistry: { discoverPluginRoot: vi.fn(() => null) },
    progressStore: {} as never,
    launchOrchestrator: launchOrchestrator as never,
  });
  const resume = (invocation = ctx) => service.resume('codex', { jobId: entry.jobId, prompt: 'continue' }, invocation);
  return { runtime, launchOrchestrator, resume };
}

describe('JobLaunchService continuation retention admission', () => {
  it('rejects resume when retention discard request is in flight', async () => {
    const f = fixture();
    await expect(f.resume()).resolves.toMatchObject({
      status: 'refused',
      code: 'retention_discard_in_flight',
      message: expect.stringContaining('Run coral-cli jobs wait 10000000-0000-4000-8000-000000000001'),
    });
    expect(f.launchOrchestrator.launchExecution).not.toHaveBeenCalled();
  });

  it('rejects a job with no conversationRef before activation', async () => {
    const f = fixture(sessionEntry({ conversationRef: undefined, retentionDiscard: { attempts: [] } }));
    await expect(f.resume()).resolves.toMatchObject({ status: 'refused', code: 'non_resumable' });
    expect(f.launchOrchestrator.launchExecution).not.toHaveBeenCalled();
  });

  it('rejects a caller profile that differs from the conversation binding', async () => {
    const f = fixture(sessionEntry({ retentionDiscard: { attempts: [] } }));
    await expect(
      f.resume({
        ...ctx,
        providerScope: withTestProfileLocation(TEST_CODEX_SCOPE, 'codex', '/other-profile'),
      }),
    ).resolves.toMatchObject({ status: 'refused', code: 'provider_binding_profile_mismatch' });
    expect(f.launchOrchestrator.launchExecution).not.toHaveBeenCalled();
  });

  it('rejects a missing work directory without substituting the caller directory', async () => {
    const f = fixture(sessionEntry({ cwd: fixtureCanonicalWorkDir('/gone'), retentionDiscard: { attempts: [] } }));
    f.runtime.storage.mkdirSync(ctx.projectRoot, { recursive: true });
    await expect(f.resume()).resolves.toMatchObject({ status: 'refused', code: 'work_directory_missing' });
    expect(f.launchOrchestrator.launchExecution).not.toHaveBeenCalled();
    expect(f.runtime.storage.existsSync('/gone')).toBe(false);
  });

  it('rejects a work directory replaced by a file', async () => {
    const f = fixture(sessionEntry({ cwd: fixtureCanonicalWorkDir('/gone'), retentionDiscard: { attempts: [] } }));
    f.runtime.storage.writeFileSync('/gone', 'a file');
    await expect(f.resume()).resolves.toMatchObject({ status: 'refused', code: 'work_directory_missing' });
    expect(f.launchOrchestrator.launchExecution).not.toHaveBeenCalled();
  });

  it('keeps an unobservable work directory undetermined', async () => {
    const f = fixture(sessionEntry({ retentionDiscard: { attempts: [] } }));
    vi.spyOn(f.runtime.storage, 'statSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    await expect(f.resume()).resolves.toMatchObject({ status: 'undetermined', code: 'work_directory_unobservable' });
    expect(f.launchOrchestrator.launchExecution).not.toHaveBeenCalled();
  });
});
