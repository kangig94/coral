import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createStartupMintAuthorizer,
  prepareRetainedControllerHandoff,
} from '#src/coordinator/services/startup-retirement.js';
import { latestControllerOpen, recordControllerOpen } from '#src/coordinator/succession/controller-open.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { sha256Hex } from '#src/infra/hash.js';
import { retainedBuildRoot } from '#src/infra/retained-build-root.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { bindCustodyIdentity, recordCustodyIntent } from '#src/store/custody-ledger.js';
import { observeEpochClosure } from '#src/store/epoch-closure.js';
import { readEpochKey } from '#src/store/epoch-key.js';
import {
  encodeResolvedStoreEpoch,
  inspectCurrentStore,
  settleStoreEpoch,
  type StoreMintDisposition,
  type StoreMintObservation,
} from '#src/store/epoch.js';
import { openSettledTestStoreDb } from '#tests/helpers/store-db.js';
import { assertBuildArtifactsAvailable, createPluginFixture } from '#tests/integration/coordinator/helpers.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function unreadableEpochRuntime(): Runtime {
  const home = mkdtempSync(join(tmpdir(), 'coral-startup-retirement-'));
  homes.push(home);
  const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
  const db = openSettledTestStoreDb(runtime);
  const path = db.location();
  db.close();
  if (path === null) throw new Error('Settled test store has no path.');
  const unreadable = newRawDatabase(path);
  unreadable.exec(`UPDATE meta SET value = 'sha256:${'0'.repeat(64)}' WHERE key = 'store_format_fingerprint'`);
  unreadable.close();
  return runtime;
}

function startUp(
  runtime: Runtime,
  index: JobLocationIndex,
  startupId: string,
  beforeAuthorize: (observation: StoreMintObservation) => void = () => {},
): StoreMintDisposition | null {
  const authorize = createStartupMintAuthorizer(runtime, index, startupId);
  let disposition: StoreMintDisposition | null = null;
  const storeFormat = currentCoralStoreFormat();
  try {
    settleStoreEpoch(runtime, {
      storeFormat,
      build: {
        version: storeFormat.productVersion,
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
        bundleHash: '0123456789abcdef',
        cliBundleHash: '0123456789abcdef',
        claudeAppserverBundleHash: '0123456789abcdef',
        durableWrapperBundleHash: '0123456789abcdef',
        flavor: runtime.flavor,
        storeFormatFingerprint: storeFormat.fingerprint,
      },
      authorizeMint: (observation) => {
        beforeAuthorize(observation);
        disposition = authorize(observation);
        return disposition;
      },
    }).db.close();
  } catch {
    // A refused mint leaves the startup unserved; the disposition it was refused on is what is asserted.
  }
  return disposition;
}

describe('startup mint authorizer', () => {
  it('keeps an unavailable current epoch as the mint predecessor and waits for inventory', () => {
    const home = mkdtempSync(join(tmpdir(), 'coral-unavailable-predecessor-'));
    homes.push(home);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    openSettledTestStoreDb(runtime).close();
    const current = inspectCurrentStore(runtime);
    if (current.kind !== 'current') throw new Error('Expected a current epoch.');
    chmodSync(current.epoch.path, 0o000);
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    let observed: StoreMintObservation | null = null;

    expect(
      startUp(runtime, index, 'startup-1', (observation) => {
        observed = observation;
      }),
    ).toBeNull();

    expect(observed).toMatchObject({
      incumbent: { epoch: current.epoch.epoch },
      classification: { kind: 'unavailable' },
    });
    expect(index.unknownLocationHold(encodeResolvedStoreEpoch(runtime, current.epoch))).not.toBeNull();
  });

  it('treats failed inventory with no known locations as unknown work', () => {
    const runtime = unreadableEpochRuntime();
    const current = inspectCurrentStore(runtime);
    if (current.kind !== 'current') throw new Error('Expected a current epoch.');
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const open = runtime.storage.openSqliteDatabaseSync;
    vi.spyOn(runtime.storage, 'openSqliteDatabaseSync').mockImplementation((path, options) => {
      if (path === current.epoch.path && options?.readOnly) throw new Error('injected inventory failure');
      return open(path, options);
    });

    expect(startUp(runtime, index, 'startup-1')).toBeNull();
    expect(index.locationsFor(encodeResolvedStoreEpoch(runtime, current.epoch))).toEqual([]);
    expect(index.unknownLocationHold(encodeResolvedStoreEpoch(runtime, current.epoch))).not.toBeNull();
  });
  it.each(['missing', 'unreadable'] as const)(
    'retains a %s-metadata epoch with a durable running job before minting',
    (metadata) => {
      const base = unreadableEpochRuntime();
      let now = Date.now();
      const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
      const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
      const current = inspectCurrentStore(runtime);
      if (current.kind !== 'current') throw new Error('Expected a current epoch.');
      const db = newRawDatabase(current.epoch.path);
      db.prepare(
        `INSERT INTO projection_jobs (
      job_id, execution_owner, phase, diagnostics, session_id, provider, project_root, work_dir,
      backend_namespace, job_kind, created_at, last_seq
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'durable-running-job',
        JSON.stringify({ kind: 'provider-session', id: 'session-1' }),
        'running',
        JSON.stringify({ progressFaults: [] }),
        'session-1',
        'claude',
        '/workspace/project',
        '/workspace/project',
        'namespace',
        'provider',
        '2026-09-25T00:00:00.000Z',
        1,
      );
      db.prepare('INSERT INTO events (seq, ts, type, stream_kind, stream_id, body) VALUES (?, ?, ?, ?, ?, ?)').run(
        1,
        '2026-09-25T00:00:00.000Z',
        'job.launch.requested',
        'job',
        'durable-running-job',
        Buffer.from(
          JSON.stringify({
            projectRoot: '/workspace/project',
            jobKind: 'provider',
            request: { cwd: '/workspace/project' },
          }),
        ),
      );
      db.close();
      const metadataPath = join(dirname(current.epoch.path), 'epoch.json');
      rmSync(metadataPath);
      if (metadata === 'unreadable') mkdirSync(metadataPath);

      expect(startUp(runtime, index, 'startup-1')).toBeNull();
      expect(index.read('durable-running-job')).toMatchObject({ disposition: 'unresolved' });
      now += 10_000;
      expect(startUp(runtime, index, 'startup-2')).toMatchObject({ kind: 'unopenable' });
      expect(index.read('durable-running-job')).toMatchObject({ disposition: 'unresolved' });
    },
  );

  it('waits for custody against an unproven epoch before minting', () => {
    const runtime = unreadableEpochRuntime();
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const current = inspectCurrentStore(runtime);
    if (current.kind !== 'current') throw new Error('Expected a current epoch.');
    encodeResolvedStoreEpoch(runtime, current.epoch);
    recordCustodyIntent(runtime, runtime.paths.coral.coordinator.runDir, {
      effect: 'process-spawn',
      epoch: dirname(current.epoch.path),
      owner: 'job',
      operationId: 'custodied-job',
      jobId: 'custodied-job',
      capsule: null,
      bindWithinMs: 1_000,
      nowMs: runtime.time.now(),
    });
    rmSync(join(dirname(current.epoch.path), 'epoch.json'));

    expect(startUp(runtime, index, 'custody-startup')).toBeNull();
  });

  it.each([true, false])('hands back a live job with a compatible epoch: %s', async (compatible) => {
    assertBuildArtifactsAvailable();
    const runtime = unreadableEpochRuntime();
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const fixture = createPluginFixture(homes, { flavor: 'prod' });
    const manifest = JSON.parse(
      readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
    ) as StrictBundleManifest;
    const current = inspectCurrentStore(runtime);
    if (current.kind !== 'current') throw new Error('Expected a current epoch.');
    if (!compatible) {
      const older = newRawDatabase(current.epoch.path);
      older.exec("UPDATE meta SET value = '0.1.0' WHERE key = 'store_product_version'");
      older.close();
    }
    const epochKey = encodeResolvedStoreEpoch(runtime, current.epoch);
    const lineageKey = readEpochKey(runtime, current.epoch);
    if (lineageKey === null) throw new Error('Expected a lineage key.');
    cpSync(fixture.root, retainedBuildRoot(runtime, manifest.buildSetId), { recursive: true });
    recordControllerOpen(runtime, epochKey, 'retained-instance', null, fixture.root, manifest, 1);
    const opened = latestControllerOpen(runtime, epochKey, 'retained-instance').latest;
    if (opened === null) throw new Error('Expected a recorded controller open.');
    vi.spyOn(runtime.process, 'execSync').mockReturnValue({
      status: 0,
      stdout: `${JSON.stringify({
        kind: 'retained-epoch-open',
        version: 'v1',
        epochKey,
        instanceId: opened.instanceId,
        buildSetId: opened.build.buildSetId,
        bundleHash: opened.build.bundleHash,
      })}\n`,
      stderr: '',
    });
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const exited = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    try {
      await Promise.all([once(live, 'spawn'), once(exited, 'spawn')]);
      for (const [jobId, child] of [
        ['live-job', live],
        ['exited-job', exited],
      ] as const) {
        if (child.pid === undefined) throw new Error('Custody process has no pid.');
        const incarnation = runtime.process.readProcessIncarnation(
          child.pid,
          runtime.env.platform() as NodeJS.Platform,
        );
        if (incarnation === null) throw new Error('Custody process incarnation was not observable.');
        index.register(
          jobId,
          epochKey,
          {
            projectRoot: '/workspace/project',
            workDir: '/workspace/project',
            jobKind: 'provider',
          },
          { instanceId: 'retained-instance', buildSetId: manifest.buildSetId, controlGeneration: 1 },
        );
        if (jobId === 'exited-job')
          index.recordObserved(jobId, {
            status: {
              jobId,
              owner: { kind: 'provider-session', id: 'session-1' },
              sessionId: 'session-1',
              provider: 'claude',
              projectRoot: '/workspace/project',
              workDir: null,
              backendNamespace: 'namespace',
              jobKind: 'provider',
              phase: 'running',
              updatedAt: '2026-09-25T00:00:00.000Z',
              lastSeq: 1,
            },
            events: [],
            readiness: 'ready',
            exit: null,
          });
        const intent = recordCustodyIntent(runtime, runtime.paths.coral.coordinator.runDir, {
          effect: 'process-spawn',
          epoch: dirname(current.epoch.path),
          epochKey: lineageKey,
          owner: 'job',
          operationId: jobId,
          jobId,
          capsule: null,
          bindWithinMs: 1_000,
          nowMs: runtime.time.now(),
        });
        bindCustodyIdentity(runtime, runtime.paths.coral.coordinator.runDir, intent, {
          process: { pid: child.pid, incarnation, processGroupId: child.pid },
          capsule: null,
          observedAtMs: runtime.time.now(),
        });
      }
      const exit = once(exited, 'exit');
      exited.kill('SIGKILL');
      await exit;

      expect(prepareRetainedControllerHandoff(runtime, index)?.epochKey).toBe(epochKey);
    } finally {
      live.kill('SIGKILL');
      exited.kill('SIGKILL');
      if (live.exitCode === null) await once(live, 'exit');
    }
  });

  it.each([true, false])(
    'hands a holding job to its verified retained controller despite another lineage hold when the root is available: %s',
    (rootAvailable) => {
      assertBuildArtifactsAvailable();
      const base = unreadableEpochRuntime();
      let now = Date.now();
      const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
      const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
      const fixture = createPluginFixture(homes, { flavor: 'prod' });
      const manifest = JSON.parse(
        readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
      ) as StrictBundleManifest;
      const current = inspectCurrentStore(runtime);
      if (current.kind !== 'current') throw new Error('Expected an unreadable current epoch.');
      const older = newRawDatabase(current.epoch.path);
      older.exec("UPDATE meta SET value = '0.1.0' WHERE key = 'store_product_version'");
      older.close();
      const epochKey = encodeResolvedStoreEpoch(runtime, current.epoch);
      const lineageKey = readEpochKey(runtime, current.epoch);
      if (lineageKey === null) throw new Error('Expected an epoch lineage key.');
      index.register(
        'live-job',
        epochKey,
        { projectRoot: '/workspace/project', workDir: '/workspace/project', jobKind: 'provider' },
        { instanceId: 'retained-instance', buildSetId: manifest.buildSetId, controlGeneration: 1 },
      );
      recordControllerOpen(runtime, epochKey, 'retained-instance', null, fixture.root, manifest, 1);
      recordCustodyIntent(runtime, runtime.paths.coral.coordinator.runDir, {
        effect: 'process-spawn',
        epoch: dirname(current.epoch.path),
        epochKey: lineageKey,
        owner: 'job',
        operationId: 'live-job',
        jobId: 'live-job',
        capsule: null,
        bindWithinMs: 1_000,
        nowMs: runtime.time.now(),
      });
      recordCustodyIntent(runtime, runtime.paths.coral.coordinator.runDir, {
        effect: 'provider-operation-publication',
        epoch: dirname(current.epoch.path),
        epochKey: lineageKey,
        owner: 'provider-operation',
        operationId: 'pending-publication',
        capsule: null,
        bindWithinMs: 1_000,
        nowMs: runtime.time.now(),
      });
      recordCustodyIntent(runtime, runtime.paths.coral.coordinator.runDir, {
        effect: 'process-spawn',
        epoch: join(runtime.paths.coral.store.dbDir, 'epoch-999'),
        epochKey: 'unrelated-lineage',
        owner: 'job',
        operationId: 'other-job',
        jobId: 'other-job',
        capsule: null,
        bindWithinMs: 1_000,
        nowMs: runtime.time.now(),
      });
      if (rootAvailable) {
        cpSync(fixture.root, retainedBuildRoot(runtime, manifest.buildSetId), { recursive: true });
        const opened = latestControllerOpen(runtime, epochKey, 'retained-instance').latest;
        if (opened === null) throw new Error('Expected a recorded controller open.');
        vi.spyOn(runtime.process, 'execSync').mockReturnValue({
          status: 0,
          stdout: `${JSON.stringify({
            kind: 'retained-epoch-open',
            version: 'v1',
            epochKey,
            instanceId: opened.instanceId,
            buildSetId: opened.build.buildSetId,
            bundleHash: opened.build.bundleHash,
          })}\n`,
          stderr: '',
        });
      }

      const handoff = prepareRetainedControllerHandoff(runtime, index);
      expect(handoff === null).toBe(!rootAvailable);
      if (rootAvailable) expect(handoff?.epochKey).toBe(epochKey);
      else {
        expect(startUp(runtime, index, 'startup-without-retained-root')).toBeNull();
        now += 10_000;
        expect(startUp(runtime, index, 'startup-without-retained-root-retry')).toMatchObject({ kind: 'unopenable' });
      }
    },
  );

  it('waits before minting when an unreadable epoch has no known job records', () => {
    const base = unreadableEpochRuntime();
    let now = Date.now();
    const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);

    expect(startUp(runtime, index, 'startup-1')).toBeNull();
    now += 10_000;
    expect(startUp(runtime, index, 'startup-2')).toMatchObject({ kind: 'unopenable' });
  });

  it('should mint over an unreadable epoch whose closure record is unreadable instead of failing startup', () => {
    const base = unreadableEpochRuntime();
    let now = Date.now();
    const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const stateRoot = runtime.paths.coral.generation.dataRoot;
    let lineageKey: string | null = null;
    const corruptClosure = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      lineageKey = readEpochKey(runtime, observation.incumbent);
      if (lineageKey === null) throw new Error('Expected the unreadable epoch to carry a lineage key.');
      mkdirSync(join(stateRoot, 'epoch-closure.v1'), { recursive: true });
      writeFileSync(join(stateRoot, 'epoch-closure.v1', `${sha256Hex(lineageKey)}.json`), 'not a closure record');
    };

    expect(startUp(runtime, index, 'startup-1', corruptClosure)).toBeNull();
    now += 10_000;
    expect(startUp(runtime, index, 'startup-2')).toMatchObject({ kind: 'unopenable' });
    expect(lineageKey).not.toBeNull();
    expect(observeEpochClosure(runtime, stateRoot, lineageKey ?? '')).toMatchObject({ kind: 'unreadable' });
  });

  it('should keep two-startup patience when a job location names the unreadable epoch', () => {
    const base = unreadableEpochRuntime();
    let now = Date.now();
    const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const registerJob = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      index.register('job-in-unreadable-epoch', encodeResolvedStoreEpoch(runtime, observation.incumbent), {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
    };

    expect(startUp(runtime, index, 'startup-1', registerJob)).toBeNull();
    now += 10_000;
    expect(startUp(runtime, index, 'startup-2')).toMatchObject({ kind: 'unopenable' });
  });

  it('preserves additive retirement patience fields across startup observations', () => {
    const base = unreadableEpochRuntime();
    let now = Date.now();
    const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const registerJob = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      index.register('job-in-unreadable-epoch', encodeResolvedStoreEpoch(runtime, observation.incumbent), {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
    };
    expect(startUp(runtime, index, 'startup-1', registerJob)).toBeNull();
    const directory = join(runtime.paths.coral.coordinator.runDir, 'retirement-patience.v1');
    const name = runtime.storage.readdirSync(directory)[0];
    if (name === undefined) throw new Error('Expected retirement patience record.');
    const path = join(directory, name);
    const prior = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    runtime.storage.writeAtomicDurableSync(path, `${JSON.stringify({ ...prior, futureField: 'keep' })}\n`);

    now += 10_000;
    expect(startUp(runtime, index, 'startup-2')).toMatchObject({ kind: 'unopenable' });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({ attempts: 2, futureField: 'keep' });
  });

  it('should count startups racing within one patience interval as a single observation', () => {
    const base = unreadableEpochRuntime();
    let now = Date.now();
    const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const registerJob = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      index.register('job-in-unreadable-epoch', encodeResolvedStoreEpoch(runtime, observation.incumbent), {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
    };

    expect(startUp(runtime, index, 'hook-spawn', registerJob)).toBeNull();
    now += 100;
    expect(startUp(runtime, index, 'cli-ensure-spawn')).toBeNull();
    now += 10_000;
    expect(startUp(runtime, index, 'cli-ensure-spawn')).toMatchObject({ kind: 'unopenable' });
  });

  it('should count one startup observing the unreadable epoch again once the patience interval has passed', () => {
    const base = unreadableEpochRuntime();
    let now = Date.now();
    const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const registerJob = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      index.register('job-in-unreadable-epoch', encodeResolvedStoreEpoch(runtime, observation.incumbent), {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
    };

    expect(startUp(runtime, index, 'startup-1', registerJob)).toBeNull();
    expect(startUp(runtime, index, 'startup-1')).toBeNull();
    now += 10_000;
    expect(startUp(runtime, index, 'startup-1')).toMatchObject({ kind: 'unopenable' });
  });

  it.each([
    ['a transient executor failure waits out bounded patience', 73, [null, 'unopenable']],
    ['an executor that cannot identify as the controller waits out bounded patience', 71, [null, 'unopenable']],
  ] as const)('should treat %s', (_label, executorExit, dispositions) => {
    assertBuildArtifactsAvailable();
    const base = unreadableEpochRuntime();
    let now = Date.now();
    const runtime: Runtime = { ...base, time: { ...base.time, now: () => now } };
    const index = new JobLocationIndex(runtime, runtime.paths.coral.generation.dataRoot);
    const fixture = createPluginFixture(homes, { flavor: 'prod' });
    const manifest = JSON.parse(
      readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8'),
    ) as StrictBundleManifest;
    cpSync(fixture.root, retainedBuildRoot(runtime, manifest.buildSetId), { recursive: true });
    vi.spyOn(runtime.process, 'execSync').mockReturnValue({ status: executorExit, stdout: '', stderr: '' });
    const liveJobUnderRetainedController = (observation: StoreMintObservation): void => {
      if (observation.incumbent === null) throw new Error('Expected the unreadable epoch as incumbent.');
      const epochKey = encodeResolvedStoreEpoch(runtime, observation.incumbent);
      index.register('live-job', epochKey, {
        projectRoot: '/workspace/project',
        workDir: '/workspace/project',
        jobKind: 'provider',
      });
      recordControllerOpen(runtime, epochKey, 'retained-instance', null, fixture.root, manifest, 1);
    };

    expect(startUp(runtime, index, 'startup-1', liveJobUnderRetainedController)?.kind ?? null).toBe(dispositions[0]);
    if (dispositions.length > 1) {
      now += 10_000;
      expect(startUp(runtime, index, 'startup-2')?.kind ?? null).toBe(dispositions[1]);
    }
  });
});
