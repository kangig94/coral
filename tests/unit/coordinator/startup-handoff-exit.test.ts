import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCoordinatorServer } from '#src/coordinator/index.js';
import * as lifecycle from '#src/coordinator/lifecycle.js';
import * as startup from '#src/coordinator/succession/startup.js';
import { handoffStartupToSelectedBuild } from '#src/coordinator/bootstrap.js';
import type * as NodeProcessModule from '#src/infra/node-process.js';
import type * as HandoffRunner from '#src/coordinator/handoff-routing/runner.js';
import * as bundleManifest from '#src/infra/bundle-manifest.js';
import * as startupStoreRouting from '#src/store/startup-store-routing.js';
import { prepareDurableCliRecoveryGrant } from '#src/coordinator/services/durable-cli-transfer.js';
import { advanceSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { createForeignTargetValidator, withValidatedHandoffTarget } from '#src/infra/handoff-target.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { JobStore } from '#src/jobs/store.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { RecoveryService } from '#src/coordinator/services/recovery/service.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { encodeResolvedStoreEpoch, settleStoreEpoch } from '#src/store/epoch/index.js';
import { storeEpochLockPath, storeEpochHolderPath } from '#src/store/epoch/observation.js';
import { joinSuccessionWriterGeneration, recordSuccessionServing } from '#src/store/succession-writer-generation.js';
import { compareAndSwapUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { recordControllerOpen, latestControllerOpen } from '#src/coordinator/succession/controller-open.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { authorizeFixtureStoreMint } from '#tests/helpers/store-db.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';

const runner = vi.hoisted(() => ({ runHandoff: vi.fn() }));
vi.mock('#src/coordinator/handoff-routing/runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HandoffRunner>()),
  runHandoff: runner.runHandoff,
}));

const processEvidence = vi.hoisted(() => ({ unknownPid: 100_000_002, alivePid: 100_000_003 }));
vi.mock('#src/infra/node-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeProcessModule>()),
  createRecordedProcessObserver: () => (recorded: { pid: number }) =>
    recorded.pid === processEvidence.unknownPid
      ? 'unknown'
      : recorded.pid === processEvidence.alivePid
        ? 'alive'
        : 'absent',
}));

const roots: string[] = [];
const releaseForeignLocks: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const release of releaseForeignLocks.splice(0)) await release();
  vi.restoreAllMocks();
  runner.runHandoff.mockReset();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(serve = false, targetVersion: '0.10.27' | '0.10.29' = '0.10.27') {
  const home = mkdtempSync(join(tmpdir(), 'coral-handoff-exit-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const pluginRoot = join(home, 'plugin');
  mkdirSync(join(pluginRoot, 'bridge'), { recursive: true });
  writeFileSync(
    join(pluginRoot, 'bridge', 'manifest.json'),
    JSON.stringify({ bundleHash: '0123456789abcdef', flavor: 'prod' }),
  );
  const olderPluginRoot = mkdtempSync(join(home, 'older-'));
  mkdirSync(join(olderPluginRoot, 'bridge'));
  const bundleDir = realpathSync(join(olderPluginRoot, 'bridge'));
  const source = 'process.exit(0);';
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const manifest = {
    version: targetVersion,
    buildSetId:
      targetVersion === '0.10.29' ? '00000000-0000-4000-8000-000000000029' : '00000000-0000-4000-8000-000000000027',
    flavor: 'prod' as const,
    storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
    bundleHash: hash,
    cliBundleHash: hash,
    claudeAppserverBundleHash: hash,
    durableWrapperBundleHash: hash,
  };
  for (const file of ['coral-backend.cjs', 'coral-cli', 'coral-claude-appserver.cjs', 'coral-durable-wrapper.cjs'])
    writeFileSync(join(bundleDir, file), source);
  writeFileSync(join(bundleDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), JSON.stringify(manifest));
  const validation = createForeignTargetValidator()(bundleDir, manifest);
  if (validation.kind !== 'validated') throw new Error('older fixture did not validate');
  const target = validation.target;
  const subject = { purpose: 'recovery-grant', identity: 'dead-attempt' };
  const prepareNoIncumbentHandoff = vi.fn((): { target: typeof target; epochKey: string } | null => ({
    target,
    epochKey: 'old-epoch',
  }));
  const ordinaryStoreSelection = new Error('ordinary store selection reached');
  const createLifecycle = lifecycle.createLifecycle;
  vi.spyOn(lifecycle, 'createLifecycle').mockImplementation((deps, recover) => {
    if (serve) {
      const rehydrate = deps.providerRegistry.rehydrateBinding.bind(deps.providerRegistry);
      vi.spyOn(deps.providerRegistry, 'rehydrateBinding').mockImplementation((envelope) => {
        const result = rehydrate(envelope);
        return result.ok
          ? {
              ...result,
              value: {
                ...result.value,
                readiness: async (use: 'launch' | 'resume' | 'recovery') => ({
                  ok: true as const,
                  value: { ready: true as const, use },
                }),
              },
            }
          : result;
      });
    }
    return createLifecycle(
      {
        ...deps,
        prepareNoIncumbentHandoff,
        prepareRecoveryGrantHandoff: () => target,
        ...(serve
          ? {}
          : {
              registerBuiltInProvidersFn: () => {
                throw ordinaryStoreSelection;
              },
            }),
      },
      recover,
    );
  });
  const prepareCommitted = startup.prepareCommittedSuccessorRecovery;
  vi.spyOn(startup, 'prepareCommittedSuccessorRecovery').mockResolvedValue({ kind: 'none' });
  const createCoordinator = () =>
    createCoordinatorServer({
      runtime,
      pluginRoot,
      backendNamespace: 'round1',
      onFatalShutdownError: vi.fn(),
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      writeBackendInfoFn: () => true,
      removeBackendInfoIfOwnerFn: () => {},
      createServerFn: (handler) => createServer(handler),
      listenFn: async () => ({ port: 0, host: '127.0.0.1' }),
      closeServerFn: async () => {},
    });
  return {
    coordinator: createCoordinator(),
    createCoordinator,
    runtime,
    pluginRoot,
    target,
    subject,
    manifest,
    prepareNoIncumbentHandoff,
    ordinaryStoreSelection,
    prepareCommitted,
    olderPluginRoot,
  };
}

async function legacyControllerFixture(targetVersion: '0.10.27' | '0.10.29' = '0.10.27') {
  const f = fixture(true, targetVersion);
  const format = currentCoralStoreFormat();
  const current = {
    ...f.manifest,
    buildSetId: '00000000-0000-4000-8000-000000000028',
    version: format.productVersion,
    storeFormatFingerprint: format.fingerprint,
  };
  vi.spyOn(bundleManifest, 'resolveStrictBundleIdentity').mockReturnValue({ ok: true, manifest: current });
  const settled = settleStoreEpoch(f.runtime, {
    storeFormat: format,
    build: current,
    authorizeMint: authorizeFixtureStoreMint,
  });
  settled.db.close();
  const writer = joinSuccessionWriterGeneration(f.runtime, settled.store);
  const epochKey = encodeResolvedStoreEpoch(f.runtime, settled.store);
  recordSuccessionServing(f.runtime, writer.generation, {
    attemptId: '00000000-0000-4000-8000-000000000003',
    epochKey,
    successorInstanceId: 'legacy-controller',
    controlGeneration: writer.generation.generation,
    recordedAt: new Date(f.runtime.time.now()).toISOString(),
  });
  recordControllerOpen(
    f.runtime,
    epochKey,
    'legacy-controller',
    null,
    f.olderPluginRoot,
    f.manifest,
    writer.generation.generation,
  );
  expect(latestControllerOpen(f.runtime, epochKey).latest?.process).toBeUndefined();
  expect(f.runtime.storage.existsSync(f.runtime.paths.coral.coordinator.upgradeIntentFile)).toBe(false);
  expect(f.runtime.storage.existsSync(f.runtime.paths.coral.coordinator.infoFile)).toBe(false);
  vi.spyOn(startup, 'resolveIncompleteSuccessionAtStartup').mockResolvedValue({ kind: 'none' });
  f.prepareNoIncumbentHandoff.mockReturnValue({ target: f.target, epochKey });
  const baseNow = f.runtime.time.now();
  const clock = vi.spyOn(f.runtime.time, 'now');
  for (let boot = 1; boot <= 3; boot += 1) {
    clock.mockReturnValue(baseNow + boot * 60_000);
    await startup.createStartupHandoffObserver(f.runtime, `boot-${boot}`, f.target, {
      purpose: 'no-incumbent',
      identity: epochKey,
    })('not-serving');
  }
  return { ...f, current, settled, epochKey, baseNow, clock };
}

const FOREIGN_EPOCH_LOCK_WAIT_MS = 2_000;

async function waitForForeignChild(work: Promise<void>, phase: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Foreign epoch lock ${phase} deadline expired`)),
          FOREIGN_EPOCH_LOCK_WAIT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function holdForeignEpochLock(path: string): Promise<() => Promise<void>> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      String.raw`
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN; SELECT count(*) FROM sqlite_schema');
    process.stdout.write('held\n');
    process.stdin.resume();
    process.stdin.on('end', () => {
      db.exec('ROLLBACK'); db.close();
    });
  `,
      path,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let reaped = false;
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => {
      reaped = true;
      resolve();
    }),
  );
  const release = async (): Promise<void> => {
    if (reaped) return;
    child.stdin.end();
    try {
      await waitForForeignChild(closed, 'release');
    } catch (error) {
      child.kill('SIGKILL');
      await waitForForeignChild(closed, 'termination');
      throw error;
    }
  };
  releaseForeignLocks.push(release);
  const ready = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.off('error', failed);
      child.off('close', exited);
      child.stdout.off('data', reported);
    };
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const exited = (code: number | null): void =>
      failed(new Error(`Foreign epoch lock exited before acquisition: ${code}`));
    const reported = (): void => {
      cleanup();
      resolve();
    };
    child.once('error', failed);
    child.once('close', exited);
    child.stdout.once('data', reported);
  });
  try {
    await waitForForeignChild(ready, 'acquisition');
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

describe('startup handoff lifecycle exit', () => {
  it('should record a failed selected child through the lifecycle handoff observer after execution consumes its target', async () => {
    const f = fixture();
    vi.spyOn(startup, 'resolveIncompleteSuccessionAtStartup').mockResolvedValue({
      kind: 'handoff',
      target: f.target,
      subject: f.subject,
    });
    const error = await f.coordinator.start().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(lifecycle.StartupStoreHandoffError);
    if (!(error instanceof lifecycle.StartupStoreHandoffError)) throw error;
    runner.runHandoff.mockImplementation(async () => {
      withValidatedHandoffTarget(f.target);
      return {
        kind: 'recorded',
        continuation: {
          kind: 'delegated-startup',
          version: '0.10.27',
          observation: { kind: 'not-serving', childEnding: { code: 0, signal: null } },
        },
        publicationIncidents: [],
      };
    });
    expect(await handoffStartupToSelectedBuild(f.pluginRoot, error)).toMatchObject({ kind: 'failed', exitCode: 1 });
    const evidence = f.runtime.storage.readdirSync(
      join(f.runtime.paths.coral.coordinator.runDir, 'succession-startup-patience.v1'),
    );
    expect(evidence).toHaveLength(1);
    const record = JSON.parse(
      f.runtime.storage.readFileSync(
        join(f.runtime.paths.coral.coordinator.runDir, 'succession-startup-patience.v1', evidence[0]),
        'utf-8',
      ),
    ) as { startups: number };
    expect(record.startups).toBe(1);
  });

  it.each([
    { path: 'no-incumbent', deaths: 'proven' },
    { path: 'no-incumbent', deaths: 'unknown' },
    { path: 'no-incumbent-without-intent', deaths: 'proven' },
    { path: 'no-incumbent-without-intent', deaths: 'unknown' },
    { path: 'committed-recovery', deaths: 'proven' },
    { path: 'committed-recovery', deaths: 'unknown' },
    { path: 'unserved-attempt', deaths: 'proven' },
    { path: 'unserved-attempt', deaths: 'unknown' },
  ] as const)(
    'should serve beyond boot four after $path exhaustion only with $deaths deaths',
    async ({ path, deaths }) => {
      const f = fixture(true);
      const noIncumbent = path.startsWith('no-incumbent');
      const format = currentCoralStoreFormat();
      const current = {
        ...f.manifest,
        buildSetId: '00000000-0000-4000-8000-000000000028',
        version: format.productVersion,
        storeFormatFingerprint: format.fingerprint,
      };
      vi.spyOn(bundleManifest, 'resolveStrictBundleIdentity').mockReturnValue({ ok: true, manifest: current });
      const settled = settleStoreEpoch(f.runtime, {
        storeFormat: format,
        build: current,
        authorizeMint: authorizeFixtureStoreMint,
      });
      const queuedJobId = '00000000-0000-4000-8000-000000000041';
      const corruptJobId = '00000000-0000-4000-8000-000000000042';
      const jobs = new JobStore('round1', f.runtime, createEventBodyCodec(), {
        db: settled.db,
        providers: permissiveProviderLookupPort,
      });
      for (const [index, jobId] of [queuedJobId, corruptJobId].entries()) {
        seedTestSessionProjection(settled.db, {
          jobId,
          provider: 'codex',
          projectRoot: f.pluginRoot,
          backendNamespace: 'round1',
        });
        jobs.appendLaunchRequested(jobId, {
          jobId,
          owner: { kind: 'provider-session', id: jobId },
          execution: 1,
          provider: 'codex',
          projectRoot: f.pluginRoot,
          backendNamespace: 'round1',
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: index + 1,
          providerAction: 'exec',
          request: { prompt: '', cwd: f.pluginRoot, bypassPermissions: false, coralEnv: {} },
          createdAt: new Date(f.runtime.time.now()).toISOString(),
        });
        jobs.commit((commit) => {
          commit.append({
            type: 'job.execution.queued',
            stream: { kind: 'job', id: jobId },
            namespace: 'round1',
            project: f.pluginRoot,
            refs: { jobId },
            body: { execution: 1, queuePosition: index + 1, runningJobIds: [] },
          });
          return undefined;
        });
      }
      const unreadableKey = `provider_operation_saga.v1:record:${corruptJobId}:00000000-0000-4000-8000-000000000043:00000000-0000-4000-8000-000000000044:00000000-0000-4000-8000-000000000045`;
      settled.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(unreadableKey, 'not json');
      settled.db.close();
      const adopted = vi.spyOn(RecoveryService.prototype, 'recoverQueuedJob').mockResolvedValue(queuedJobId);
      const writer = joinSuccessionWriterGeneration(f.runtime, settled.store);
      const epochKey = encodeResolvedStoreEpoch(f.runtime, settled.store);
      const attemptId = '00000000-0000-4000-8000-000000000003';
      const controllerId = path === 'committed-recovery' ? 'successor' : 'incumbent';
      const recordedAt = new Date(f.runtime.time.now()).toISOString();
      recordSuccessionServing(f.runtime, writer.generation, {
        attemptId,
        epochKey,
        successorInstanceId: controllerId,
        controlGeneration: writer.generation.generation,
        recordedAt,
      });
      const dead = { pid: 100_000_001, incarnation: testIncarnation(100_000_001) };
      const owner = deaths === 'proven' ? dead : { pid: processEvidence.unknownPid, incarnation: null };
      recordControllerOpen(
        f.runtime,
        epochKey,
        controllerId,
        null,
        f.olderPluginRoot,
        f.manifest,
        writer.generation.generation,
        owner,
      );
      let successionPreparation = null;
      if (path === 'unserved-attempt') {
        advanceSuccessionWriterGeneration(f.runtime, writer.generation, settled.store);
        const transfer = { epochPath: settled.store.path, jobs: [] };
        const recoveryGrantId = prepareDurableCliRecoveryGrant(f.runtime, f.runtime.paths.coral.coordinator.runDir, {
          version: 'v1',
          attemptId,
          epochKey,
          incumbentInstanceId: 'incumbent',
          incumbentBuildSetId: f.manifest.buildSetId,
          transfer,
        });
        successionPreparation = {
          version: 'v1',
          requestId: 'request',
          attemptId,
          incumbentInstanceId: 'incumbent',
          incumbentPid: owner.pid,
          incumbentKey: 'incumbent',
          targetKey: 'target',
          capabilitiesKey: 'capabilities',
          epochKey,
          admissionRevision: 0,
          accepts: [],
          receipts: [
            {
              owner: 'durable-cli',
              generation: 1,
              attemptId,
              receiptId: 'receipt',
              recoveryGrantId,
              payload: transfer,
            },
          ],
          stage: 'prepared',
          ready: null,
        };
      }
      if (path !== 'no-incumbent-without-intent') {
        const written = await compareAndSwapUpgradeIntent(f.runtime.paths.coral.coordinator.runDir, null, {
          requestId: 'request',
          incumbent: {
            instanceId: 'incumbent',
            ...(path === 'committed-recovery' ? dead : owner),
            version: '0.10.27',
            bundleHash: f.manifest.bundleHash,
            flavor: 'prod',
          },
          target: { build: f.manifest, pluginRootLabel: f.olderPluginRoot },
          attemptId: noIncumbent ? null : attemptId,
          attemptOwner: !noIncumbent
            ? { kind: 'incumbent', instanceId: 'incumbent', ...(path === 'committed-recovery' ? dead : owner) }
            : null,
          attemptChild: path === 'unserved-attempt' ? { attemptId, ...dead } : null,
          disposition:
            path === 'committed-recovery' ? 'completed' : path === 'unserved-attempt' ? 'attempting' : 'deferred',
          blockers: [],
          retryCondition: null,
          attemptDeadline: null,
          completionReceipt:
            path === 'committed-recovery'
              ? {
                  kind: 'serving',
                  attemptId,
                  successor: { instanceId: 'successor', ...owner, build: f.manifest },
                  epochKey,
                  controlGeneration: writer.generation.generation,
                  acceptedObligations: [],
                  recordedAt,
                }
              : null,
          successionPreparation,
        });
        if (written.kind !== 'written') throw new Error(`fixture intent failed: ${JSON.stringify(written)}`);
      }
      if (path === 'committed-recovery') {
        vi.mocked(startup.prepareCommittedSuccessorRecovery).mockImplementation(
          (runtime, identity, storeFormat, build) =>
            f.prepareCommitted(runtime, identity, storeFormat, build, () => true),
        );
      }
      if (noIncumbent) {
        vi.spyOn(startup, 'resolveIncompleteSuccessionAtStartup').mockResolvedValue({ kind: 'none' });
        f.prepareNoIncumbentHandoff.mockReturnValue({ target: f.target, epochKey });
      } else {
        f.prepareNoIncumbentHandoff.mockReturnValue({ target: f.target, epochKey });
      }
      const baseNow = f.runtime.time.now();
      const clock = vi.spyOn(f.runtime.time, 'now');
      const subject = { purpose: noIncumbent ? 'no-incumbent' : path, identity: noIncumbent ? epochKey : attemptId };
      for (let boot = 1; boot <= 3; boot += 1) {
        clock.mockReturnValue(baseNow + boot * 60_000);
        await startup.createStartupHandoffObserver(f.runtime, `boot-${boot}`, f.target, subject)('not-serving');
      }
      for (let boot = 4; boot <= 6; boot += 1) {
        clock.mockReturnValue(baseNow + boot * 60_000);
        const coordinator = f.createCoordinator();
        adopted.mockClear();
        if (deaths === 'unknown') {
          try {
            await expect(coordinator.start()).rejects.toMatchObject({
              name: 'SuccessionAttemptStartupHoldError',
              hold: { kind: 'deaths-unproven' },
            });
          } finally {
            if (coordinator.getLifecycle() === 'running') await coordinator.shutdown('test-teardown');
          }
        } else {
          try {
            await coordinator.start();
            expect(coordinator.getLifecycle()).toBe('running');
            const db = f.runtime.storage.openSqliteDatabaseSync(settled.store.path, { readOnly: true });
            try {
              if (boot === 4) {
                expect(adopted).toHaveBeenCalledWith(
                  expect.objectContaining({ launchRecord: expect.objectContaining({ jobId: queuedJobId }) }),
                );
              } else {
                expect(db.prepare('SELECT phase FROM projection_jobs WHERE job_id = ?').get(queuedJobId)).toEqual({
                  phase: 'error',
                });
                expect(
                  db
                    .prepare("SELECT type FROM events WHERE stream_id = ? AND type = 'job.interrupted'")
                    .all(queuedJobId),
                ).toHaveLength(1);
              }
              expect(db.prepare('SELECT boundary_id, subject_key FROM recovery_quarantine').all()).toContainEqual({
                boundary_id: 'provider-operation-unreadable',
                subject_key: unreadableKey,
              });
            } finally {
              db.close();
            }
            expect(latestControllerOpen(f.runtime, epochKey).latest).toMatchObject({
              build: { buildSetId: current.buildSetId },
              process: { pid: process.pid },
            });
          } finally {
            await coordinator.shutdown('test-teardown');
          }
        }
      }
    },
  );

  it.each(['recover', 'hold'] as const)(
    'should stop delegating an exhausted selected-store handoff and %s through its exact-epoch recovery',
    async (outcome) => {
      const f = await legacyControllerFixture('0.10.29');
      f.prepareNoIncumbentHandoff.mockReturnValue(null);
      vi.spyOn(startupStoreRouting, 'routeOrOpenBackendStoreAtStartup').mockResolvedValue({
        kind: 'handoff',
        target: f.target,
        source: 'active-selection',
      });
      if (outcome === 'hold')
        writeFileSync(
          storeEpochHolderPath(f.settled.store.storeRoot, '00000000-0000-4000-8000-000000000067'),
          JSON.stringify({ epoch: f.settled.store.epoch, pid: process.pid }),
        );
      await expect(f.createCoordinator().start()).rejects.toBeInstanceOf(lifecycle.StartupStoreHandoffError);
      for (let boot = 1; boot <= 3; boot += 1) {
        f.clock.mockReturnValue(f.baseNow + boot * 60_000);
        await startup.createStartupHandoffObserver(f.runtime, `selected-${boot}`, f.target, {
          purpose: 'selected-store',
          identity: f.runtime.paths.coral.store.dbDir,
        })('not-serving');
      }
      for (let boot = 4; boot <= 6; boot += 1) {
        f.clock.mockReturnValue(f.baseNow + boot * 60_000);
        const coordinator = f.createCoordinator();
        try {
          if (outcome === 'hold') {
            await expect(coordinator.start()).rejects.toMatchObject({
              name: 'SuccessionAttemptStartupHoldError',
              hold: { kind: 'preferred-epoch-unopenable' },
            });
          } else {
            await coordinator.start();
            expect(coordinator.getLifecycle()).toBe('running');
            expect(latestControllerOpen(f.runtime, f.epochKey).latest).toMatchObject({
              build: { buildSetId: f.current.buildSetId },
              process: { pid: process.pid },
            });
          }
        } finally {
          if (coordinator.getLifecycle() === 'running') await coordinator.shutdown('test-teardown');
        }
      }
    },
  );

  it('should serve legacy controllers without intent or process evidence after singleton and epoch exclusion', async () => {
    const f = await legacyControllerFixture();
    for (let boot = 4; boot <= 6; boot += 1) {
      f.clock.mockReturnValue(f.baseNow + boot * 60_000);
      const coordinator = f.createCoordinator();
      try {
        await coordinator.start();
        expect(coordinator.getLifecycle()).toBe('running');
        expect(latestControllerOpen(f.runtime, f.epochKey).latest).toMatchObject({
          build: { buildSetId: f.current.buildSetId },
          process: { pid: process.pid },
        });
      } finally {
        if (coordinator.getLifecycle() === 'running') await coordinator.shutdown('test-teardown');
      }
    }
  });

  it('should hold a legacy controller while a foreign epoch lease is held and serve after kernel release', async () => {
    const f = await legacyControllerFixture();
    const release = await holdForeignEpochLock(storeEpochLockPath(f.settled.store.storeRoot, f.settled.store.epoch));
    for (let boot = 4; boot <= 6; boot += 1) {
      f.clock.mockReturnValue(f.baseNow + boot * 60_000);
      const coordinator = f.createCoordinator();
      try {
        await expect(coordinator.start()).rejects.toMatchObject({ name: 'SuccessionAttemptStartupHoldError' });
        expect(latestControllerOpen(f.runtime, f.epochKey).latest?.process).toBeUndefined();
      } finally {
        if (coordinator.getLifecycle() === 'running') await coordinator.shutdown('test-teardown');
      }
    }
    await release();
    f.clock.mockReturnValue(f.baseNow + 7 * 60_000);
    const coordinator = f.createCoordinator();
    try {
      await coordinator.start();
      expect(coordinator.getLifecycle()).toBe('running');
    } finally {
      if (coordinator.getLifecycle() === 'running') await coordinator.shutdown('test-teardown');
    }
  });

  it.each(['alive', 'unknown'] as const)(
    'should retain a parked %s legacy holder even when its epoch lock is free',
    async (liveness) => {
      const f = await legacyControllerFixture();
      expect(startup.proveLegacyControllerAbsence(f.runtime, f.epochKey, null)).toBeNull();
      const pid = liveness === 'alive' ? process.pid : processEvidence.unknownPid;
      writeFileSync(
        storeEpochHolderPath(f.settled.store.storeRoot, '00000000-0000-4000-8000-000000000066'),
        JSON.stringify({ epoch: f.settled.store.epoch, pid }),
      );
      const observeLiveness = f.runtime.process.observeLiveness.bind(f.runtime.process);
      vi.spyOn(f.runtime.process, 'observeLiveness').mockImplementation((observed) =>
        observed === pid ? liveness : observeLiveness(observed),
      );
      for (let boot = 4; boot <= 6; boot += 1) {
        f.clock.mockReturnValue(f.baseNow + boot * 60_000);
        const coordinator = f.createCoordinator();
        try {
          await expect(coordinator.start()).rejects.toMatchObject({ name: 'SuccessionAttemptStartupHoldError' });
        } finally {
          if (coordinator.getLifecycle() === 'running') await coordinator.shutdown('test-teardown');
        }
      }
    },
  );

  it.each(['alive', 'unknown'] as const)(
    'should retain %s discovery evidence for a legacy controller before opening its epoch',
    async (liveness) => {
      const f = await legacyControllerFixture();
      const pid = liveness === 'alive' ? processEvidence.alivePid : processEvidence.unknownPid;
      writeFileSync(
        f.runtime.paths.coral.coordinator.infoFile,
        JSON.stringify({
          pid,
          incarnation: testIncarnation(pid),
          port: 12345,
          socketPath: f.runtime.paths.coral.coordinator.socketPath,
          bundleHash: f.manifest.bundleHash,
          flavor: 'prod',
          namespace: 'round1',
          instanceId: 'legacy-controller',
          startedAt: f.baseNow,
          token: 'token',
          bootToken: 'boot-token',
        }),
      );
      for (let boot = 4; boot <= 6; boot += 1) {
        f.clock.mockReturnValue(f.baseNow + boot * 60_000);
        const coordinator = f.createCoordinator();
        try {
          await expect(coordinator.start()).rejects.toMatchObject({ name: 'SuccessionAttemptStartupHoldError' });
        } finally {
          if (coordinator.getLifecycle() === 'running') await coordinator.shutdown('test-teardown');
        }
      }
    },
  );

  it('should continue ordinary store selection after recovery discharge without selecting the old controller again', async () => {
    const f = fixture();
    vi.spyOn(startup, 'resolveIncompleteSuccessionAtStartup').mockResolvedValue({ kind: 'ordinary' });
    await expect(f.coordinator.start()).rejects.toBe(f.ordinaryStoreSelection);
  });
});
