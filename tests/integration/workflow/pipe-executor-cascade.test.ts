import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseAgentRef, resolveAgent } from '#src/jobs/agent-resolution.js';
import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { JobStore } from '#src/jobs/store.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { ExecutionService } from '#src/coordinator/execution-service.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import type { ProviderInstruction, ProviderRequest } from '#src/providers/contract.js';
import { managed } from '#src/providers/capability.js';
import { toProviderDefinition, type Provider } from '#tests/helpers/scripted-provider.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import { streamProviderEvents, streamProviderTerminal } from '#src/providers/stream.js';
import { workflowCompiler } from '#src/workflow/compile.js';
import { workflowCommands } from '#src/workflow/dispatch.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { openTestStoreDb } from '#tests/helpers/store-db.js';
import { createTestJobJournalDeps } from '#tests/helpers/job-journal-deps.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { createLifecycleReactor } from '#src/sessions/lifecycle-reactor.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import type { CommitEventsFn } from '#src/store/append.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

type RecordedLaunchRequest = ProviderRequest & {
  instruction?: ProviderInstruction;
};

function cloneProviderRequest(request: ProviderRequest): RecordedLaunchRequest {
  return {
    ...request,
    coralEnv: { ...request.coralEnv },
    ...(request.instruction ? { instruction: { ...request.instruction } } : {}),
  };
}

describe('pipe executor coral cascade invariant', () => {
  it('forces coral workflow atoms to resolve from the coral plugin instead of the project override', async () => {
    const suffix = process.pid.toString(36);
    const SENTINEL_PROJECT = 'SENTINEL_PROJECT_' + suffix;
    const SENTINEL_CORAL = 'SENTINEL_CORAL_' + suffix;

    const projectRoot = fixtureCanonicalWorkDir(mkdtempSync(join(tmpdir(), 'pipe-cascade-proj-')));
    const coralPluginRoot = mkdtempSync(join(tmpdir(), 'pipe-cascade-coral-'));
    // Isolate from the user's real ~/.coral state so stale-schema DBs created
    // before unrelated rename commits don't poison this integration test.
    // createRealRuntime() resolves coralRoot via homedir(); pointing HOME at a
    // fresh tmp dir gives the runtime a clean store path that the schema
    // loader will populate from current SQL.
    const isolatedHome = mkdtempSync(join(tmpdir(), 'pipe-cascade-home-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;

    try {
      const projectArchitectPath = join(projectRoot, '.claude', 'agents', 'architect.md');
      const coralArchitectPath = join(coralPluginRoot, 'agents', 'architect.md');

      mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
      mkdirSync(join(coralPluginRoot, 'agents'), { recursive: true });
      writeFileSync(projectArchitectPath, '---\n---\n' + SENTINEL_PROJECT);
      writeFileSync(coralArchitectPath, '---\n---\n' + SENTINEL_CORAL);

      expect(projectRoot).not.toBe(coralPluginRoot);
      expect(existsSync(projectArchitectPath)).toBe(true);
      expect(existsSync(coralArchitectPath)).toBe(true);
      expect(readFileSync(projectArchitectPath, 'utf8')).toContain(SENTINEL_PROJECT);
      expect(readFileSync(coralArchitectPath, 'utf8')).toContain(SENTINEL_CORAL);
      const runtime = createRealRuntime('prod');

      const resolutionCtx = {
        projectRoot,
        coralPluginRoot,
        discoverPluginRoot: () => null,
        storage: runtime.storage,
      };

      const bareResolved = resolveAgent(parseAgentRef('architect'), resolutionCtx);
      expect(bareResolved.content).toContain(SENTINEL_PROJECT);
      expect(bareResolved.content).not.toContain(SENTINEL_CORAL);
      expect(bareResolved.path.startsWith(projectRoot)).toBe(true);

      const forcedResolved = resolveAgent(parseAgentRef('coral:architect'), resolutionCtx);
      expect(forcedResolved.path.startsWith(join(coralPluginRoot, 'agents') + sep)).toBe(true);
      expect(forcedResolved.content).toContain(SENTINEL_CORAL);
      expect(forcedResolved.content).not.toContain(SENTINEL_PROJECT);

      const capturedLaunches: RecordedLaunchRequest[] = [];
      const stubProvider: Provider = {
        name: 'codex',
        execute: (request) => {
          capturedLaunches.push(cloneProviderRequest(request));
          return streamProviderTerminal({
            content: 'stub-provider-result',
            durationMs: 0,
            outcome: { kind: 'completed' },
          });
        },
      };

      const providerRegistry = new ProviderRegistry();
      providerRegistry.register(toProviderDefinition(stubProvider)!);

      const eventBus = new TypedEventBus();
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
      const bodyCodec = createEventBodyCodec();
      const db = openTestStoreDb(runtime, runtime.paths.coral.store.dbFile);
      const reactorRef: { current?: ReturnType<typeof createLifecycleReactor> } = {};
      const progressStore = new JobStore('test-ns', runtime, bodyCodec, {
        db,
        eventBus,
        reducers,
        providers: permissiveProviderLookupPort,
        observer: (appended) => {
          if (reactorRef.current === undefined) {
            throw new Error('Lifecycle reactor observed events before initialization');
          }
          reactorRef.current.observe(appended);
        },
      });
      const coordinatorCommit: CommitEventsFn = (cb) => progressStore.commit(cb);
      reactorRef.current = createLifecycleReactor({
        db: () => db,
        readCtx: { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec },
        providers: providerRegistry,
        runtime,
        time: runtime.time,
        commitEvents: coordinatorCommit,
        signal: new AbortController().signal,
      });
      const executionSvc = new ExecutionService(
        {
          projectRoot,
          pluginRoot: coralPluginRoot,
          coralEnv: {},
          principal: testProjectPrincipal(projectRoot),
          providerScope: TEST_CODEX_SCOPE,
        },
        {
          childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
          runtime,
          progressStore,
          bundleHash: 'pipe-executor-cascade-test',
          backendNamespace: pluginRootNamespace(coralPluginRoot),
          launchCoordinator: new LaunchCoordinator({ runtime }),
          eventBus,
          providerRegistry,
          pluginRegistry: { discoverPluginRoot: () => null },
          ...createTestJobJournalDeps(progressStore, runtime),
          coordinatorCommit,
        },
      );

      const ctx: InvocationContext = {
        projectRoot,
        pluginRoot: coralPluginRoot,
        coralEnv: {},
        principal: testProjectPrincipal(projectRoot),
        providerScope: TEST_CODEX_SCOPE,
      };
      const compiled = workflowCompiler.compile(
        {
          expression: 'architect',
          startPrompt: 'hi',
          provider: 'codex',
          workDir: projectRoot,
        },
        providerRegistry,
      );
      if ('status' in compiled) {
        throw new Error(`expected workflow compilation to succeed, got ${compiled.status}`);
      }

      const decision = await workflowCommands.execute(executionSvc, compiled, ctx);

      expect(decision.status).toBe('running');
      if (decision.status === 'rejected') {
        throw new Error(`expected workflow launch to succeed, got ${decision.message}`);
      }
      await executionSvc.waitForJobTerminal(decision.jobId, 1_000);
      expect(capturedLaunches).toHaveLength(1);

      const [launch] = capturedLaunches;
      expect(launch.instruction).toBeDefined();
      if (!launch.instruction) {
        throw new Error('Expected coralDispatch launch to include a resolved instruction');
      }
      expect(launch.instruction.content).toContain(SENTINEL_CORAL);
      expect(launch.instruction.content).not.toContain(SENTINEL_PROJECT);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(coralPluginRoot, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });

  it('deletes workflow atom provider artifacts through retention reactor events', async () => {
    const projectRoot = fixtureCanonicalWorkDir(mkdtempSync(join(tmpdir(), 'pipe-retention-proj-')));
    const coralPluginRoot = mkdtempSync(join(tmpdir(), 'pipe-retention-coral-'));
    const isolatedHome = mkdtempSync(join(tmpdir(), 'pipe-retention-home-'));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = isolatedHome;
    process.env.USERPROFILE = isolatedHome;

    try {
      mkdirSync(join(coralPluginRoot, 'agents'), { recursive: true });
      writeFileSync(join(coralPluginRoot, 'agents', 'architect.md'), '---\n---\nartifact cleanup architect');

      const runtime = createRealRuntime('prod');
      const artifactPath = join(projectRoot, 'atom-artifact.jsonl');
      writeFileSync(artifactPath, '{"event":"provider-artifact"}\n');
      expect(existsSync(artifactPath)).toBe(true);

      const providerRegistry = new ProviderRegistry();
      const stubProvider: Provider = {
        name: 'codex',
        execute: () =>
          streamProviderEvents((emit) => {
            emit({
              kind: 'artifact_handle',
              handle: artifactPath,
              identity: { kind: 'test-artifact', path: artifactPath },
            });
            emit({
              kind: 'terminal',
              terminal: { content: 'artifact-cleaned', durationMs: 0, outcome: { kind: 'completed' } },
              diagnostics: {},
            });
          }),
        artifactCapability: managed({
          discardArtifacts: async ({ handles, runtime: cleanupRuntime }) => {
            for (const handle of handles) {
              cleanupRuntime.storage.unlinkSync(handle);
            }
            return { kind: 'discarded' };
          },
        }),
      };
      providerRegistry.register(toProviderDefinition(stubProvider)!);

      const eventBus = new TypedEventBus();
      const reducers = composeReducers(jobsRegistry, sessionsRegistry, workflowRegistry);
      const bodyCodec = createEventBodyCodec();
      const db = openTestStoreDb(runtime, runtime.paths.coral.store.dbFile);
      const reactorRef: { current?: ReturnType<typeof createLifecycleReactor> } = {};
      const progressStore = new JobStore('test-ns', runtime, bodyCodec, {
        db,
        eventBus,
        reducers,
        providers: permissiveProviderLookupPort,
        observer: (appended) => {
          if (reactorRef.current === undefined) {
            throw new Error('Lifecycle reactor observed events before initialization');
          }
          reactorRef.current.observe(appended);
        },
      });
      const coordinatorCommit: CommitEventsFn = (cb) => progressStore.commit(cb);
      const reactor = createLifecycleReactor({
        db: () => db,
        readCtx: { schemas: reducers.schemas, streamKinds: reducers.streamKinds, bodyCodec },
        providers: providerRegistry,
        runtime,
        time: runtime.time,
        commitEvents: coordinatorCommit,
        signal: new AbortController().signal,
      });
      reactorRef.current = reactor;
      const executionSvc = new ExecutionService(
        {
          projectRoot,
          pluginRoot: coralPluginRoot,
          coralEnv: {},
          principal: testProjectPrincipal(projectRoot),
          providerScope: TEST_CODEX_SCOPE,
        },
        {
          childPrincipalRegistry: new ChildPrincipalRegistry(runtime.ids),
          runtime,
          progressStore,
          bundleHash: 'pipe-executor-retention-test',
          backendNamespace: pluginRootNamespace(coralPluginRoot),
          launchCoordinator: new LaunchCoordinator({ runtime }),
          eventBus,
          providerRegistry,
          pluginRegistry: { discoverPluginRoot: () => null },
          ...createTestJobJournalDeps(progressStore, runtime),
          coordinatorCommit,
        },
      );

      const ctx: InvocationContext = {
        projectRoot,
        pluginRoot: coralPluginRoot,
        coralEnv: {},
        principal: testProjectPrincipal(projectRoot),
        providerScope: TEST_CODEX_SCOPE,
      };
      const compiled = workflowCompiler.compile(
        {
          expression: 'architect',
          startPrompt: 'hi',
          provider: 'codex',
          workDir: projectRoot,
        },
        providerRegistry,
      );
      if ('status' in compiled) {
        throw new Error(`expected workflow compilation to succeed, got ${compiled.status}`);
      }

      const decision = await workflowCommands.execute(executionSvc, compiled, ctx);

      expect(decision.status).toBe('running');
      if (decision.status === 'rejected') {
        throw new Error(`expected workflow launch to succeed, got ${decision.message}`);
      }
      await executionSvc.waitForJobTerminal(decision.jobId, 1_000);

      await vi.waitFor(
        async () => {
          await reactor.waitForIdle();
          expect(existsSync(artifactPath)).toBe(false);
        },
        { timeout: 1_000 },
      );
      const retentionRows = db
        .prepare(
          `SELECT type, body
             FROM events
            WHERE type IN ('session.retention.discard.requested', 'session.retention.discard.completed')
            ORDER BY seq ASC`,
        )
        .all() as Array<{ type: string; body: Buffer }>;
      expect(
        retentionRows.map((row) => ({
          type: row.type,
          body: decodeEventBody(row.body),
        })),
      ).toEqual([
        {
          type: 'session.retention.discard.requested',
          body: expect.objectContaining({ attempt: 1, handles: [artifactPath] }),
        },
        {
          type: 'session.retention.discard.completed',
          body: expect.objectContaining({ attempt: 1, handles: [artifactPath], outcome: 'discarded' }),
        },
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(coralPluginRoot, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
    }
  });
});
