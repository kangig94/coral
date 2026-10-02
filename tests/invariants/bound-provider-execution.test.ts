import { describe, expect, it, vi } from 'vitest';

import { none } from '#src/providers/capability.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { JobLaunchService } from '#src/coordinator/services/job-launch.js';
import { testChildPrincipalRegistry } from '#tests/helpers/child-principal-registry.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { AbortRegistry } from '#src/jobs/shell/abort-registry.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import { fixtureProviderBindingCodec, type FixtureProviderAccess } from '#tests/helpers/provider-binding.js';
import { prepareFixtureExecutionPlan, type FixtureExecutionPlan } from '#tests/helpers/scripted-provider.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';

describe('bound-provider execution architecture', () => {
  it('launches a newly registered fixture provider through generic job launch and orchestration', async () => {
    let dispatched = false;
    let prepared = false;
    let observedSource: FixtureProviderAccess | undefined;
    let observedCliEnv: Readonly<Record<string, string>> | undefined;
    const definition = defineProvider<FixtureExecutionPlan, FixtureProviderAccess>({
      name: 'fixture',
      transport: 'standalone',
      prepareExecutionPlan: (input) => {
        prepared = true;
        observedSource = input.access;
        return prepareFixtureExecutionPlan(input);
      },
      run: async function* (_request, runtime) {
        dispatched = true;
        await runtime.runCli({ command: 'fixture', args: ['--run'] });
        yield {
          kind: 'terminal' as const,
          terminal: { content: 'fixture-result', durationMs: 0, outcome: { kind: 'completed' as const } },
          diagnostics: {},
        };
      },
    })
      .binding(fixtureProviderBindingCodec('fixture'))
      .artifacts(none('fixture provider has no native artifacts'))
      .build();
    const providers = new ProviderRegistry();
    providers.register(definition);
    const runtime = new SimulationRuntime();
    const abortRegistry = new AbortRegistry(runtime.ids);
    let storedSession: ProviderSession | null = null;
    let releaseCompleted!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseCompleted = resolve;
    });
    const sessionManager = {
      prepare(options: {
        binding: ProviderSession['binding'];
        name: string;
        cwd: string;
        projectRoot: string;
        backendNamespace: string;
      }): ProviderSession {
        storedSession = {
          sessionId: 'fixture-session',
          binding: options.binding,
          name: options.name,
          state: 'ready',
          retention: 'retain',
          artifactHandles: [],
          retentionDiscard: { attempts: [] },
          cwd: options.cwd,
          projectRoot: options.projectRoot,
          backendNamespace: options.backendNamespace,
          providerContinuity: null,
          createdAt: '2026-07-22T00:00:00.000Z',
          lastUsedAt: '2026-07-22T00:00:00.000Z',
          version: 0,
        };
        return storedSession;
      },
      appendPreparedClaim(_commit: unknown, preparedSession: ProviderSession, jobId: string): ProviderSession {
        storedSession = { ...preparedSession, activeJobId: jobId, version: preparedSession.version + 1 };
        return storedSession;
      },
      observeCommittedEntry(entry: ProviderSession) {
        storedSession = entry;
      },
      get(provider: string, sessionId: string) {
        return storedSession?.binding.provider === provider && storedSession.sessionId === sessionId
          ? storedSession
          : null;
      },
      async checkpointJobContinuityAtomic() {
        return { ok: false as const };
      },
      async recordArtifactHandleAtomic() {
        return { ok: false as const };
      },
      async releaseJobClaimAtomic() {
        if (storedSession !== null) {
          const { activeJobId: _activeJobId, ...releasedSession } = storedSession;
          storedSession = { ...releasedSession, version: storedSession.version + 1 };
        }
        releaseCompleted();
        return true;
      },
      releaseJob() {},
    };
    const appended: unknown[] = [];
    const terminalCalls: unknown[] = [];
    const coordinatorCommit = (callback: (commit: unknown) => undefined) => {
      callback({ append: (event: unknown) => (appended.push(event), {}) });
      return [];
    };
    const progressStore = {
      nextEnqueueSequence: () => 1,
      readLaunchProjection: () => null,
      readStatus: () => null,
      jobDir: (jobId: string) => `/tmp/${jobId}`,
      appendProgress() {},
      appendRuntimeStarted() {},
      commit() {},
    };
    const launchCoordinator = new LaunchCoordinator({ runtime });
    const orchestrator = new LaunchOrchestrator({
      abortRegistry,
      progressStore: progressStore as never,
      sessionManager: sessionManager as never,
      launchAdmission: launchCoordinator,
      providerOperationBinding: launchCoordinator,
      durableSpawner: {
        async spawnDurableJob(options: { exactEnv?: Record<string, string> }) {
          observedCliEnv = options.exactEnv;
          return { stdout: '', stderr: '', code: 0, aborted: false };
        },
      } as never,
      providerRegistry: providers,
      runtime,
      coordinatorCommit: coordinatorCommit as never,
      backendNamespace: 'fixture-backend',
      bundleHash: 'fixture-bundle',
      settlementRefusalRecorder: { record: () => true },
      terminalMaterializer: {
        recordProviderTerminal(_store: unknown, event: unknown, metadata: unknown) {
          terminalCalls.push({ event, metadata });
        },
      },
    });
    const service = new JobLaunchService({
      runtime,
      sessionManager: sessionManager as never,
      backendNamespace: 'fixture-backend',
      bundleHash: 'fixture-bundle',
      providerRegistry: providers,
      pluginRegistry: { discoverPluginRoot: () => null },
      progressStore: progressStore as never,
      launchOrchestrator: orchestrator,
      childPrincipalRegistry: testChildPrincipalRegistry(runtime.ids),
    });

    expect(Object.keys(definition)).toEqual(['name']);
    const decision = await service.start(
      'fixture',
      { prompt: 'run', cwd: fixtureCanonicalWorkDir('/fixture'), jobId: 'fixture-job' },
      {
        projectRoot: fixtureCanonicalWorkDir('/fixture'),
        pluginRoot: '/plugin',
        coralEnv: { FIXTURE_TUNING: 'precise', CORAL_CLAUDE_MODEL_CAP: 'must-not-leak' },
        principal: testProjectPrincipal('/fixture'),
        providerScope: {
          origin: 'caller',
          profiles: [{ provider: 'fixture', profile: { canonicalLocation: '/fixture', routing: {} } }],
        },
      },
    );
    await released;
    await vi.waitFor(() => expect(launchCoordinator.reservationFor('fixture-job')).toBeNull());

    expect(decision).toEqual({
      kind: 'provider-session',
      status: 'running',
      jobId: 'fixture-job',
      sessionId: 'fixture-session',
    });
    expect(prepared).toBe(true);
    expect(observedSource).toEqual({
      root: '/fixture',
      routingEnv: { FIXTURE_PROFILE_ROOT: '/fixture' },
    });
    expect(observedCliEnv).toMatchObject({
      FIXTURE_PROFILE_ROOT: '/fixture',
      FIXTURE_TUNING: 'precise',
    });
    expect(observedCliEnv).not.toHaveProperty('CORAL_CLAUDE_MODEL_CAP');
    expect(dispatched).toBe(true);
    expect(appended).toEqual([
      expect.objectContaining({
        type: 'job.launch.requested',
        stream: { kind: 'job', id: 'fixture-job' },
        refs: expect.objectContaining({ jobId: 'fixture-job', sessionId: 'fixture-session' }),
        body: expect.objectContaining({
          sessionId: 'fixture-session',
          provider: 'fixture',
        }),
      }),
      expect.objectContaining({
        type: 'job.queue.admitted',
        stream: { kind: 'job', id: 'fixture-job' },
        refs: expect.objectContaining({ jobId: 'fixture-job', sessionId: 'fixture-session' }),
        body: { queuePosition: 0 },
      }),
    ]);
    expect(terminalCalls).toEqual([
      {
        event: {
          kind: 'terminal',
          terminal: { content: 'fixture-result', durationMs: 0, outcome: { kind: 'completed' } },
          diagnostics: {},
        },
        metadata: expect.objectContaining({
          jobId: 'fixture-job',
          sessionId: 'fixture-session',
          namespace: 'fixture-backend',
          project: '/fixture',
        }),
      },
    ]);
    expect(storedSession).toMatchObject({
      sessionId: 'fixture-session',
      binding: expect.objectContaining({ provider: 'fixture' }),
    });
    expect(storedSession).not.toHaveProperty('activeJobId');
    expect(launchCoordinator.reservationFor('fixture-job')).toBeNull();
  });
});
