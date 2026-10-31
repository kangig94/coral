import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { localProviderHostRoot } from '#src/infra/bundle-manifest.js';
import { providerProxyPlacement } from '#src/coordinator/live/provider-hosts/host-root.js';
import { claudeAppServerLifecycle } from '#src/providers/claude/provider-facets.js';

import { hostFingerprintFromSpec, proxySetFingerprintFromSpec } from '#src/providers/host-identity.js';
import { createProxy } from '#src/provider-proxy/proxy.js';
import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { connectControlClient, controlExchangeForTest } from '#src/provider-proxy/control-client.js';
import { createProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createProviderProxyAuthorityFaultLatch } from '#src/coordinator/services/provider-proxy-authority-fault.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';
import { createProviderEventHandler } from '#src/coordinator/services/provider-event-application.js';
import { createProviderOperationReconcilerHarness } from '#tests/helpers/provider-operation-reconciler-harness.js';
import { asJointContainmentReceipt, asReservation } from '#tests/helpers/provider-proxy-correlation.js';
import { strictControlExchangeResult } from '#tests/support/control-exchange.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_CLAUDE_ACCESS } from '#tests/helpers/provider-credentials.js';
import { JobStore } from '#src/jobs/store.js';
import { ConversationManager } from '#src/jobs/conversation/shell.js';
import { TEST_CLAUDE_BINDING } from '#tests/helpers/provider-credentials.js';
import { ExecutionFinisher, readExecutionFinishingState } from '#src/jobs/finishing.js';
import { TypedEventBus } from '#src/coordinator/event-bus.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { readProviderOperation } from '#src/store/provider-operation-journal.js';
import { canonicalizePrincipalWire } from '#src/security/principal-wire.js';

it.each(['plugin-cache-only', 'unused-old-copy'] as const)(
  'runs and completes a proxied Claude job from the installed root with %s',
  async (topology) => {
    const directory = mkdtempSync(join(tmpdir(), 'coral-claude-installed-root-'));
    const config = {
      pluginRoot: join(directory, 'plugin-cache'),
    };
    const unusedCopy = join(directory, '.coral', 'gen2', 'builds', 'old-build');
    for (const root of topology === 'unused-old-copy' ? [config.pluginRoot, unusedCopy] : [config.pluginRoot]) {
      mkdirSync(join(root, 'bridge'), { recursive: true });
      writeFileSync(join(root, 'bridge', 'coral-claude-appserver.cjs'), '');
    }
    const runtime = createRealRuntime('prod', { baseDir: directory });
    const request = {
      action: 'exec' as const,
      jobId: '',
      prompt: 'hello',
      cwd: fixtureCanonicalWorkDir(directory),
      bypassPermissions: false,
      coralEnv: {},
    };
    const compile = (hostRoot: string) =>
      claudeAppServerLifecycle.compileStableHost(
        claudeAppServerLifecycle.planHost({
          hostRoot,
          purpose: 'execution',
          request,
          access: TEST_CLAUDE_ACCESS,
          baseEnv: {},
          platform: 'linux',
          storage: runtime.storage,
        }),
      );
    vi.stubGlobal('__PLUGIN_ROOT__', config.pluginRoot);
    vi.stubGlobal('__BUNDLE_DIR__', join(config.pluginRoot, 'bridge'));
    const coordinatorSpec = compile(providerProxyPlacement().hostRoot);
    const fingerprint = proxySetFingerprintFromSpec(coordinatorSpec);
    let store!: JobStore;
    let sessions!: ConversationManager;
    const harness = createProviderOperationReconcilerHarness({
      providerName: 'claude',
      progressStore: (db, record) => {
        store = new JobStore('tests', runtime, createEventBodyCodec(), {
          db,
          eventBus: new TypedEventBus(),
          providers: permissiveProviderLookupPort,
          reducers: composeReducers(jobsRegistry, discussRegistry, workflowRegistry),
        });
        sessions = new ConversationManager(directory, runtime, (cb) => store.commit(cb), db);
        request.jobId = record.operation.jobId;
        const conversation = sessions.prepare({
          jobId: record.operation.jobId,
          binding: TEST_CLAUDE_BINDING,
          name: 'test',
          cwd: fixtureCanonicalWorkDir(directory),
          projectRoot: directory,
          backendNamespace: 'tests',
        });
        store.initJob({
          jobId: conversation.jobId,
          conversation: {
            provider: conversation.provider,
            binding: conversation.binding,
            name: conversation.name,
            cwd: conversation.cwd,
            bypassPermissions: conversation.bypassPermissions,
            retention: conversation.retention,
          },
          projectRoot: directory,
          backendNamespace: 'tests',
        });
        return store;
      },
      authorityFor: () => authority,
    });
    Object.assign(harness.authority.setIdentity, { hostFingerprint: fingerprint });
    const { operation, locator } = harness.record;
    const endpoint = join(directory, 'proxy.sock');
    const shared = {
      generation: 'gen2' as const,
      flavor: 'prod' as const,
      buildSetId: operation.buildSetId,
      hostFingerprint: fingerprint,
      guardianInstanceId: locator.guardian.instanceId,
      reaperInstanceId: locator.reaper.instanceId,
      proxyInstanceId: operation.proxyInstanceId,
      bootstrapNonce: 'a'.repeat(64),
    };
    const timer = {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (handle: { unref?: () => void }) => clearTimeout(handle as NodeJS.Timeout),
    };
    vi.stubGlobal('__BUNDLE_DIR__', join(config.pluginRoot, 'bridge'));
    const proxySpec = compile(localProviderHostRoot());
    const proxyFingerprint = hostFingerprintFromSpec(proxySpec);
    const proxy = createProxy({
      capsule: {
        role: 'proxy',
        ...shared,
        canonicalEndpoint: endpoint,
        guardianControlEndpoint: join(directory, 'guardian.sock'),
        proxyGuardianAuthSecret: 'b'.repeat(64),
      },
      identity: {
        ...shared,
        pid: locator.proxy.pid,
        incarnation: locator.proxy.incarnation,
        processGroupId: locator.containment.processGroupId,
        canonicalEndpoint: endpoint,
      },
      clock: createMonotonicClock(Symbol('installed-root'), { readMilliseconds: () => 0n }),
      timer,
      mintChallenge: randomUUID,
      mintReceipt: randomUUID,
      mintReservation: () => asReservation(randomUUID()),
      wallClockNow: () => 100,
      host: {
        start: () => ({
          result: Promise.resolve({
            kind: 'started',
            hostRef: {
              provider: 'claude',
              fingerprint: proxyFingerprint,
              instanceId: 'test-broker',
              leaseMode: 'shared',
            },
          }),
          abortAndRelease: async () => {},
        }),
        stop: async () => {},
      },
      containment: {
        stageProviderRoot: () => ({
          result: Promise.resolve({
            state: 'staged',
            providerRoot: { pid: 104, incarnation: testIncarnation(1003) },
            receipt: asJointContainmentReceipt('contained'),
          }),
          confirmActivation: async () => {},
          abortAndRelease: async () => {},
        }),
      },
    });
    const reducers = composeReducers(jobsRegistry, discussRegistry, workflowRegistry);
    const executionFinisher = new ExecutionFinisher({
      time: runtime.time,
      commit: (cb) => store.commit(cb),
      read: (address) =>
        readExecutionFinishingState(harness.db, address, {
          schemas: reducers.schemas,
          streamKinds: reducers.streamKinds,
          bodyCodec: store.bodyCodec,
        }),
      quiesce: async () => readProviderOperation(harness.db, harness.record.operation) === null,
      retentionAction: async () => {
        throw new Error('Retained conversation requires no discard action');
      },
      settleRetention: async () => {
        throw new Error('Retained conversation requires no discard settlement');
      },
    });
    const handler = createProviderEventHandler({
      executionFinisher,
      db: harness.db,
      progressStore: store,
      appendContext: {
        now: () => new Date(100),
        reducers: composeReducers(jobsRegistry, discussRegistry, workflowRegistry),
        bodyCodec: store.bodyCodec,
        providers: permissiveProviderLookupPort,
      },
      providerRegistry: {
        rehydrateBinding: () => {
          throw new Error('No continuity in this test');
        },
        renderBindingFailure: () => 'Invalid test binding',
      },
      runtime,
      recordedStopCauseFor: () => null,
      observeCommitted: () => {},
    });
    await proxy.listen();
    const control = await connectControlClient(endpoint, timer, 1_000, handler);
    const guardian = {
      exchange: async () =>
        controlExchangeForTest({
          kind: 'response',
          response: { kind: 'result', value: { state: 'activation-authorized', jointActivationReceipt: 'activated' } },
        }),
      faulted: new Promise<never>(() => {}),
      onFault: () => () => {},
      close: () => {},
    };
    const authority = createProviderProxyOperationAuthority({
      base: { ...harness.authority, controlReattachment: {} as never },
      setIdentity: harness.authority.setIdentity,
      clients: { proxy: control, guardian, reaper: guardian },
      faults: createProviderProxyAuthorityFaultLatch(),
      mutationRpcTimeoutMs: 1_000,
    });
    try {
      harness.advance(runtime.time.now() - 100);
      harness.reconciler.start();
      const opened = (await strictControlExchangeResult(
        control,
        'control.open.v1',
        {
          bootstrapNonce: shared.bootstrapNonce,
          coordinator: {
            instanceId: randomUUID(),
            pid: process.pid,
            incarnation: testIncarnation(1),
            generation: 'gen2',
            flavor: 'prod',
            buildSetId: operation.buildSetId,
          },
        },
        1_000,
      )) as { controlEpoch: number; heartbeatChallenge: string };
      await strictControlExchangeResult(
        control,
        'control.heartbeat.v1',
        { controlEpoch: opened.controlEpoch, heartbeatChallenge: opened.heartbeatChallenge },
        1_000,
      );
      const route = createAppServerProxyRoute({
        hostManager: {
          proxyHostRoot: () => providerProxyPlacement().hostRoot,
          routeAppServerOperation: () => authority,
        },
        reconciler: harness.reconciler,
        now: () => 100,
      });
      await Promise.all([
        expect(
          route.activate(
            {
              jobId: operation.jobId,
              operationId: operation.operationId,
              jobLaunchEventSeq: harness.record.prepareSource.jobLaunchEventSeq,
              execution: 1,
              childAuthorization: {
                ...harness.record.prepareSource.childAuthorization,
                principalWire: canonicalizePrincipalWire(harness.record.prepareSource.childAuthorization.principalWire),
              },
              hostSpec: coordinatorSpec,
              provider: 'claude',
              binding: TEST_CLAUDE_BINDING,
              request,
              persistedContinuity: null,
              baseEnv: {},
              protectedEnv: {},
              platform: 'linux',
            },
            new AbortController().signal,
          ),
        ).resolves.toEqual({ kind: 'remote-executing' }),
        vi.waitFor(() => expect(store.readStatus(operation.jobId)?.phase).toBe('running')),
      ]);
      expect(coordinatorSpec).toEqual(proxySpec);
      expect(coordinatorSpec.args[0]).toBe(join(config.pluginRoot, 'bridge', 'coral-claude-appserver.cjs'));
      expect(store.readStatus(operation.jobId)?.phase).toBe('running');
      expect(
        harness.db
          .prepare('SELECT COUNT(*) AS count FROM events WHERE stream_id = ? AND type = ?')
          .get(operation.jobId, 'job.execution.started'),
      ).toEqual({ count: 1 });
      proxy.emitProviderEvent(
        { jobId: operation.jobId, operationId: operation.operationId },
        {
          kind: 'terminal',
          terminal: { content: 'done', durationMs: 1, outcome: { kind: 'completed' } },
          diagnostics: {},
        },
      );
      await vi.waitFor(() => expect(store.readStatus(operation.jobId)?.finishing).toBe(true));
      harness.reconciler.onControlEstablished(authority);
      await vi.waitFor(() => expect(store.readStatus(operation.jobId)?.phase).toBe('completed'));
      await vi.waitFor(() => expect(readProviderOperation(harness.db, operation)).toBeNull());
      expect(sessions.get('claude', request.jobId)).not.toBeNull();
      expect(sessions.get('claude', request.jobId)?.open).toBe(false);
      expect(harness.fatalErrors).toEqual([]);
    } finally {
      control.close();
      await proxy.close();
      harness.reconciler.stop();
      harness.db.close();
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  5_000,
);
