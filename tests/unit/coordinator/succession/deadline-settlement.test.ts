import { createHash } from 'node:crypto';
import { recordLegacyUpgradeIntent } from '#src/coordinator-launch/request.js';
import { CLI_BUNDLE_FILE, CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent, visibleUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { formatPendingUpgrade } from '#src/cli/format/backend.js';
import { createSuccessionReconciler } from '#src/coordinator/succession/reconciler/index.js';
import { requestedIntent } from '#src/coordinator/succession/intent-transitions.js';
import { createCommitServing } from '#src/coordinator/succession/commit/serving.js';
import { createCommitFailurePolicy } from '#src/coordinator/succession/commit/failure-policy.js';
import { createCommitRunner } from '#src/coordinator/succession/commit/runner.js';
import { createFailedCommitWindow } from '#src/coordinator/succession/commit/failed-window.js';
import { createCommitAttemptRecorder } from '#src/coordinator/succession/commit/attempt-recording.js';
import { createCommitReclaim } from '#src/coordinator/succession/commit/reclaim.js';
import type {
  CommitState,
  CommitWindow,
  IncumbentWriterPorts,
  SuccessionCommitPorts,
} from '#src/coordinator/succession/commit/index.js';
import type { SuccessionAttempt } from '#src/coordinator/succession/attempt-child.js';
import type { SuccessionPreparation } from '#src/coordinator/succession/protocol.js';
import type { SuccessionWriterEntitlement } from '#src/store/succession-writer-generation.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

it.each(['same-request', 'renewed-request', 'child-hold'])(
  'persists real serving timeouts through the commit runner and reclaim into cutover (%s)',
  async (request) => {
    const root = mkdtempSync(join(tmpdir(), 'coral-deadline-settlement-'));
    try {
      const time = new VirtualTime();
      const runtime = { ...createRealRuntime('prod', { baseDir: root }), time };
      const runDir = runtime.paths.coral.coordinator.runDir;
      let incumbent = {
        instanceId: 'incumbent',
        pid: process.pid,
        incarnation: null,
        version: '0.10.25',
        bundleHash: 'old',
        flavor: 'prod' as const,
      };
      const pluginRoot = join(root, 'target');
      const bridge = join(pluginRoot, 'bridge');
      mkdirSync(bridge, { recursive: true });
      const bytes = 'fixture build';
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      for (const file of [
        'coral-backend.cjs',
        CLI_BUNDLE_FILE,
        'coral-claude-appserver.cjs',
        'coral-durable-wrapper.cjs',
        'coral-sentinel.cjs',
      ])
        writeFileSync(join(bridge, file), bytes);
      const target = {
        pluginRootLabel: pluginRoot,
        build: {
          version: '0.10.27',
          buildSetId: '00000000-0000-4000-8000-000000000001',
          flavor: 'prod' as const,
          storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
          bundleHash: hash,
          cliBundleHash: hash,
          claudeAppserverBundleHash: hash,
          durableWrapperBundleHash: hash,
        },
      };
      writeFileSync(join(bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(target.build));
      const seeded = await compareAndSwapUpgradeIntent(
        runDir,
        null,
        requestedIntent({ requestId: 'upgrade', target }, incumbent, null),
      );
      if (seeded.kind !== 'written') throw new Error(seeded.kind);
      let intent = seeded.intent;
      const notify = vi.fn();
      const writers = { adoptProviderOperationAdmission: vi.fn() } as unknown as IncumbentWriterPorts;
      const commitIncumbent = { instanceId: incumbent.instanceId, build: null };
      const ports = {
        runtime,
        incumbent: commitIncumbent,
        log: vi.fn(),
        reconciler: () => ({ notifyObligationChange: notify }),
        setLaunchFenceActive: vi.fn(),
        waitHandover: { renew: vi.fn() },
        providerHosts: { reclaimTransferred: vi.fn() },
        storeDb: vi.fn(),
      } as unknown as SuccessionCommitPorts;
      const state: CommitState = {
        active: null,
        supervision: null,
        attemptAbort: new AbortController(),
        pausedAttemptId: null,
        stopWindowForwarding: null,
      };
      const policy = createCommitFailurePolicy(state);
      const recorder = createCommitAttemptRecorder(ports);
      const serving = createCommitServing(ports, state, { ...policy, retirementServes: () => false });
      const childHold =
        'failed successor 41002 absence is unproven (identity unavailable); the writer generation fence refuses its writes';
      const abortAndReap = async (attempt: SuccessionAttempt) =>
        request === 'child-hold' && attempt.attemptId === 'attempt-2' ? childHold : null;
      const failedWindow = createFailedCommitWindow(ports, state, {
        ...recorder,
        abortAndReap,
        successorServesBeforeRefusal: async () => 'refused',
      });
      const reclaim = createCommitReclaim(ports, {
        ...recorder,
        closePause: vi.fn(),
        writersOrThrow: () => writers,
        childHoldBlockers: policy.childHoldBlockers,
        reclaimIncumbentWriter: async ({ writer }) => ({
          kind: 'reclaimed',
          generation: writer.generation,
          providerOperationAdmission: {} as Parameters<IncumbentWriterPorts['adoptProviderOperationAdmission']>[0],
        }),
      });
      for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber++) {
        const attemptId = `attempt-${attemptNumber}`;
        const started = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
          ...intent,
          attemptId,
          disposition: 'attempting',
          attemptOwner: { kind: 'incumbent', ...incumbent },
        });
        if (started.kind !== 'written') throw new Error(started.kind);
        const attempt = {
          attemptId,
          child: { exitCode: null, signalCode: null },
          onAcknowledgment: () => () => {},
        } as unknown as SuccessionAttempt;
        const preparation = { attemptId, epochKey: 'epoch' } as SuccessionPreparation;
        const writer = { generation: { generation: 1 } } as SuccessionWriterEntitlement;
        const window: CommitWindow = {
          attempt,
          preparation,
          recovering: false,
          deadlineAt: time.now() + 2500,
          deadlineMonotonicMs: Number(time.monotonicNow()) + 2500,
          pauseDeadlineMonotonicMs: Number(time.monotonicNow()) + 5000,
          stopForwarding: vi.fn(),
          writer,
          retirementStoreParked: false,
          hold: null,
        };
        const runner = createCommitRunner(ports, {
          ...serving,
          ...failedWindow,
          ...policy,
          planCommit: () => ({ formatChanging: false, successorFingerprint: 'format' }),
          awaitAttemptReadiness: async () => {},
          abortAndReap,
          certifyRetiringCustody: async () => {
            throw new Error('format is unchanged');
          },
          openCommitWindow: async () => window,
          parkAndAuthorize: async () => writer,
        });
        const running = runner.runCommit(attempt, preparation, null);
        await flushMicrotasks(12);
        time.tick(2501);
        const outcome = await running;
        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error(outcome.kind);
        expect(outcome.childHold).toBe(request === 'child-hold' && attemptNumber === 2 ? childHold : null);
        await expect(reclaim.reclaimInPlace(outcome, false)).resolves.toEqual({ kind: 'settled' });
        const persisted = readUpgradeIntent(runDir);
        if (persisted.kind !== 'readable') throw new Error(persisted.kind);
        intent = persisted.intent;
        expect(intent.servingDeadline?.misses).toBe(attemptNumber);
        expect(intent.attemptId).toBeNull();
        if (attemptNumber === 1 && request === 'renewed-request') {
          incumbent = { ...incumbent, instanceId: 'recovery-incumbent' };
          commitIncumbent.instanceId = incumbent.instanceId;
          expect(
            await recordLegacyUpgradeIntent({ runDir, requestId: 'renewed-upgrade', incumbent, target }),
          ).toMatchObject({ kind: 'waiting', requestId: 'renewed-upgrade' });
          const renewed = readUpgradeIntent(runDir);
          if (renewed.kind !== 'readable') throw new Error(renewed.kind);
          expect(renewed.intent).toMatchObject({ requestId: 'renewed-upgrade', target });
          intent = renewed.intent;
        }
      }
      expect(intent).toMatchObject({
        legacyRetirement: true,
        disposition: 'deferred',
        retryCondition: { kind: 'incumbent-retirement' },
      });
      expect(intent.blockers).toContainEqual(expect.objectContaining({ owner: 'quiescent-cutover' }));
      expect(writers.adoptProviderOperationAdmission).toHaveBeenCalledTimes(2);
      if (request === 'child-hold') {
        const expectVisibleChildHold = () => {
          const observed = readUpgradeIntent(runDir);
          if (observed.kind !== 'readable') throw new Error(observed.kind);
          const visible = visibleUpgradeIntent(observed.intent);
          if (visible === null) throw new Error('cutover status is absent');
          expect(visible.blockers).toEqual(
            expect.arrayContaining([
              { owner: 'succession-attempt-child', reason: childHold },
              expect.objectContaining({ owner: 'quiescent-cutover' }),
            ]),
          );
          expect(formatPendingUpgrade(visible)).toContain(childHold);
          return observed.intent;
        };
        expectVisibleChildHold();
        const retire = vi.fn();
        const reconciler = createSuccessionReconciler({
          runtime,
          runDir,
          incumbent: () => incumbent,
          owners: [],
          epochKey: () => 'epoch',
          admissionRevision: () => 0,
          liveJobIds: () => [],
          retireForCutover: retire,
          retryIntervalMs: 6 * 60 * 60_000,
        });
        try {
          const restored = await compareAndSwapUpgradeIntent(runDir, intent.revision, {
            ...intent,
            legacyRetirement: false,
            blockers: intent.blockers.filter((entry) => entry.owner !== 'quiescent-cutover'),
          });
          if (restored.kind !== 'written') throw new Error(restored.kind);
          rmSync(join(bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE));
          await reconciler.reconcile();
          await vi.waitFor(() => expect(expectVisibleChildHold().servingDeadline?.outcome).toBe('unavailable'));
          expect(retire).not.toHaveBeenCalled();
          writeFileSync(join(bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(target.build));
          time.tick(60 * 60_000);
          await vi.waitFor(() => expect(retire).toHaveBeenCalledOnce());
          expect(expectVisibleChildHold().servingDeadline?.outcome).toBe('retiring');
        } finally {
          reconciler.dispose();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
