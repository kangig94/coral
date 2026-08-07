import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunStartupRecoveryOrchestratorFn } from '#src/coordinator/lifecycle.js';
import type { ProviderHostManager } from '#src/coordinator/live/provider-hosts/index.js';
import type { HostRef } from '#src/providers/contract.js';
import { ProviderRegistry } from '#src/providers/registry.js';
import { streamProviderTerminal } from '#src/providers/stream.js';
import { SessionManager } from '#src/sessions/shell.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { checkpointClaimedTestContinuity } from '#tests/helpers/session.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { defineFakeProvider } from '#tests/helpers/scripted-provider.js';

import { createHandoffCoresHarness, type HandoffCoresHarness } from './handoff-cores-harness.js';

const harnesses: HandoffCoresHarness[] = [];
const exactHostRef = {
  provider: 'codex',
  fingerprint: '1'.repeat(64),
  instanceId: 'incumbent-host',
  leaseMode: 'shared',
} as const satisfies HostRef;

const runOrdinaryJobStartup: RunStartupRecoveryOrchestratorFn = async (inputs, runJobsStartup) => {
  await runJobsStartup({
    namespace: inputs.identity.namespace,
    bundleHash: inputs.identity.bundleHash,
    runtime: inputs.runtime,
    progressStore: inputs.progressStore,
    providerRegistry: inputs.providerRegistry,
    getRecoveryService: inputs.getRecoveryService,
    createInvocationContext: inputs.createInvocationContext,
    signal: inputs.signal,
    log: inputs.identity.log,
    coordinatorCommit: (callback) => inputs.progressStore.commit(callback),
    interruptedAppServerReason: inputs.interruptedAppServerReason ?? 'restart',
  });
  return [];
};

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.cleanup();
  }
});

function createRecoveryProvider(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const provider = defineFakeProvider({
    name: 'codex',
    execute: () => streamProviderTerminal({ content: 'unused', durationMs: 0, outcome: { kind: 'completed' } }),
    appServerLifecycle: {
      host: {
        provider: 'codex',
        command: 'fixture-app-server',
        args: [],
        cwd: '/handoff/cross-namespace',
        leaseMode: 'shared',
        idleRetirement: 'none',
      },
      interrupt: async () => {},
      probe: async (_transport, continuity) => ({ resumable: true, updatedContinuity: continuity }),
      finalizeInterrupted: (_probeResult, continuity, context) => {
        if (context.preservedConversationRef === undefined) return { kind: 'preserve' };
        return {
          kind: 'set_resumable',
          conversationRef: context.preservedConversationRef,
          ...(continuity === undefined ? {} : { providerContinuity: continuity }),
        };
      },
    },
  });
  if (provider === undefined) throw new Error('Expected recovery provider fixture.');
  registry.register(provider);
  return registry;
}

function createHostManager(exactHostReachable: boolean): {
  manager: ProviderHostManager;
  attachSession: ReturnType<typeof vi.fn>;
  openSession: ReturnType<typeof vi.fn>;
} {
  const session = {
    rpc: async <Result>() => ({}) as Result,
    subscribe: () => () => {},
    closed: new Promise<Error | void>(() => {}),
  };
  const attachSession = vi.fn(async (hostRef: HostRef) => {
    expect(hostRef).toEqual(exactHostRef);
    if (!exactHostReachable) return null;
    return { session, hostRef: exactHostRef, close: () => {} };
  });
  const openSession = vi.fn(async () => {
    throw new Error('Exact incumbent host is absent');
  });
  return {
    manager: {
      attachSession,
      openSession,
      drainForHandoff: async () => {},
      shutdown: async () => {},
      routeAppServerOperation: () => null,
    },
    attachSession,
    openSession,
  };
}

describe('cross-namespace coordinator handoff', () => {
  it.each([
    { exactHostReachable: true, continuity: 'verified' as const },
    { exactHostReachable: false, continuity: 'unavailable' as const },
  ])(
    'recovers an inherited app-server job with $continuity continuity through ordinary startup',
    async ({ exactHostReachable, continuity }) => {
      const harness = createHandoffCoresHarness();
      harnesses.push(harness);

      const incumbent = await harness.bootCore({ instanceId: 'incumbent', backendNamespace: 'namespace-a' });
      const progressStore = incumbent.core.storeServicesRef.get().progressStore;
      const projectRoot = harness.homeDir;
      const jobId = `foreign-app-server-${continuity}`;
      const sessionManager = new SessionManager(
        projectRoot,
        harness.runtime,
        (callback) => progressStore.commit(callback),
        undefined,
        harness.db,
      );
      const session = sessionManager.allocate({
        binding: TEST_CODEX_BINDING,
        name: `cross-build-${continuity}`,
        model: 'gpt-5',
        cwd: projectRoot,
        projectRoot,
        backendNamespace: 'namespace-a',
      });
      expect(sessionManager.claimForJobSync(session.sessionId, jobId)).toBe(true);
      await checkpointClaimedTestContinuity(sessionManager, session.sessionId, jobId, {
        conversationRef: `thread-${continuity}`,
        resumable: true,
        providerContinuity: { threadId: `thread-${continuity}` },
      });

      const createdAt = new Date(harness.runtime.time.now()).toISOString();
      progressStore.appendLaunchRequested(jobId, {
        jobId,
        owner: { kind: 'provider-session', id: session.sessionId },
        sessionId: session.sessionId,
        provider: 'codex',
        providerAction: 'exec',
        projectRoot,
        backendNamespace: 'namespace-a',
        jobKind: 'provider',
        pool: 'default',
        enqueueSequence: progressStore.nextEnqueueSequence(),
        request: {
          prompt: 'continue after replacement',
          cwd: projectRoot,
          bypassPermissions: false,
          coralEnv: {},
        },
        createdAt,
      });
      progressStore.appendRuntimeStarted(jobId, {
        transport: 'app-server',
        startTime: createdAt,
        providerMeta: {
          provider: 'codex',
          leaseState: 'acquired',
          hostRef: exactHostRef,
        },
      });
      expect(progressStore.readStatus(jobId)?.phase).toBe('running');

      await incumbent.shutdown('replaced');

      const providerRegistry = createRecoveryProvider();
      const host = createHostManager(exactHostReachable);
      const replacement = await harness.bootCore({
        instanceId: 'replacement',
        backendNamespace: 'namespace-b',
        providerRegistry,
        providerHostManager: host.manager,
        runStartupRecoveryFn: runOrdinaryJobStartup,
      });

      const replacementStore = replacement.core.storeServicesRef.get().progressStore;
      const recovered = replacementStore.readStatus(jobId);
      expect(recovered).toMatchObject({
        phase: 'error',
        backendNamespace: 'namespace-a',
        result: {
          outcome: {
            kind: 'failed',
          },
        },
      });
      const interrupted = harness.db
        .prepare<[string], { body: Uint8Array }>(
          `SELECT body FROM events
           WHERE type = 'session.interrupted' AND stream_kind = 'session' AND stream_id = ?`,
        )
        .get(session.sessionId);
      expect(interrupted).toBeDefined();
      expect(decodeEventBody(interrupted?.body ?? new Uint8Array())).toEqual({ trigger: 'restart', continuity });
      expect(replacementStore.readJobEvents(jobId)).not.toContainEqual(
        expect.objectContaining({
          body: expect.objectContaining({
            terminal: expect.objectContaining({
              outcome: { kind: 'job_fault', fault: { kind: 'wrapper_lost' } },
            }),
          }),
        }),
      );
      expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
        state: 'ready',
        retention: 'retain',
        conversationRef: `thread-${continuity}`,
      });
      expect(sessionManager.get('codex', session.sessionId)).not.toHaveProperty('activeJobId');
      expect(host.attachSession).toHaveBeenCalledOnce();
      if (exactHostReachable) {
        expect(host.openSession).not.toHaveBeenCalled();
      } else {
        expect(host.openSession).toHaveBeenCalledOnce();
      }
    },
  );
});
