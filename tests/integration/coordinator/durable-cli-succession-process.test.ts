import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { build, type PluginBuild } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { probeProcessIncarnation, observeProcessLiveness, type ProcessIncarnation } from '#src/infra/node-process.js';
import {
  CURRENT_STRICT_BUNDLE_MANIFEST_FILE,
  SUCCESSION_CAPABILITIES_FILE,
  SUCCESSION_CAPABILITY_VERSION,
} from '#src/infra/bundle-manifest-address.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { readDurableCliControllerReceipts } from '#src/coordinator/succession/durable-cli-transfer.js';
import { readDurableCliProcessRuntimeEvidence } from '#src/jobs/runtime-meta-store.js';
import { JobLocationIndex } from '#src/jobs/location-index.js';
import { retainedBuildRoot } from '#src/infra/retained-build-root.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { readCustodyLedger } from '#src/store/custody-ledger.js';
import { decodeResolvedStoreEpoch, encodeResolvedStoreEpoch, resolveCurrentStore } from '#src/store/epoch.js';
import { resolveProtectedEpoch } from '#src/store/epoch-protection.js';
import { readEpochClosure } from '#src/store/epoch-closure.js';
import { observeSuccessionServing, observeSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type PluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { openTestStoreDatabase } from '#tests/helpers/store-db.js';

const roots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const cliChildren: ChildProcess[] = [];
const providerChildren: { pid: number; incarnation: ProcessIncarnation | null }[] = [];
const successors: { pid: number; incarnation: ProcessIncarnation | null }[] = [];

afterEach(async () => {
  for (const cli of cliChildren.splice(0)) {
    if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
  }
  for (const provider of providerChildren.splice(0)) {
    if (provider.incarnation !== null &&
      probeProcessIncarnation(provider.pid) === provider.incarnation &&
      observeProcessLiveness(provider.pid) === 'alive') {
      process.kill(provider.pid, 'SIGTERM');
    }
  }
  for (const successor of successors.splice(0)) {
    if (successor.incarnation !== null &&
      probeProcessIncarnation(successor.pid) === successor.incarnation &&
      observeProcessLiveness(successor.pid) === 'alive') {
      process.kill(successor.pid, 'SIGTERM');
    }
  }
  for (const coordinator of coordinators.splice(0)) await stopCoordinator(coordinator);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

async function createDurableFixture(version?: string, schemaSuffix?: string): Promise<PluginFixture> {
  const fixture = createPluginFixture(roots, { flavor: 'prod', ...(version === undefined ? {} : { version }) });
  const bridge = join(fixture.root, 'bridge');
  const strictPath = join(bridge, CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
  const strict = JSON.parse(readFileSync(strictPath, 'utf8')) as {
    version: string;
    buildSetId: string;
    flavor: string;
    storeFormatFingerprint: string;
    [key: string]: unknown;
  };
  const sourceBuildSetId = strict.buildSetId;
  const sourceFormatFingerprint = strict.storeFormatFingerprint;
  strict.buildSetId = randomUUID();
  for (const [name, hashKey] of [
    ['coral-cli', 'cliBundleHash'],
    ['coral-claude-appserver.cjs', 'claudeAppserverBundleHash'],
    ['coral-durable-wrapper.cjs', 'durableWrapperBundleHash'],
  ] as const) {
    const path = join(bridge, name);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(sourceBuildSetId, strict.buildSetId));
    strict[hashKey] = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  }
  const backendPath = join(bridge, 'coral-backend.cjs');
  const buildBackend = async (): Promise<void> => {
    await build({
    entryPoints: [join(process.cwd(), 'tests', 'fixtures', 'durable-succession-provider.ts')],
    outfile: backendPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:*', '@lydell/node-pty'],
    loader: { '.sql': 'text' },
    minify: true,
    ...(schemaSuffix === undefined ? {} : { plugins: [{
      name: 'schema-changing-fixture',
      setup(builder: PluginBuild) {
        builder.onLoad({ filter: /schema\.sql$/u }, (args) => ({
          contents: `${readFileSync(args.path, 'utf8')}\n${schemaSuffix}\n`, loader: 'text',
        }));
      },
    }] }),
    banner: {
      js: `var __CORAL_BUILD_IDENTITY__=${JSON.stringify({
        version: strict.version, buildSetId: strict.buildSetId, flavor: strict.flavor,
        storeFormatFingerprint: strict.storeFormatFingerprint,
      })};` +
        'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' +
        'var __BUNDLE_DIR__=__dirname;' +
        'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
    },
    define: {
      __VERSION__: JSON.stringify(strict.version),
      __BUILD_SET_ID__: JSON.stringify(strict.buildSetId),
      __BUILD_FLAVOR__: JSON.stringify(strict.flavor),
      __STORE_FORMAT_FINGERPRINT__: JSON.stringify(strict.storeFormatFingerprint),
      __IS_CORAL_BACKEND_MAIN__: 'true',
      'import.meta.url': '__importMetaUrl',
    },
    });
  };
  await buildBackend();
  if (schemaSuffix !== undefined) {
    strict.storeFormatFingerprint = execFileSync(process.execPath,
      [backendPath, '--print-store-format-fingerprint'], { encoding: 'utf8' }).trim();
    await buildBackend();
    for (const [name, hashKey] of [
      ['coral-cli', 'cliBundleHash'],
      ['coral-claude-appserver.cjs', 'claudeAppserverBundleHash'],
      ['coral-durable-wrapper.cjs', 'durableWrapperBundleHash'],
    ] as const) {
      const path = join(bridge, name);
      writeFileSync(path, readFileSync(path, 'utf8')
        .replaceAll(sourceFormatFingerprint, strict.storeFormatFingerprint));
      strict[hashKey] = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
    }
  }
  const bundleHash = createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16);
  writeFileSync(strictPath, `${JSON.stringify({ ...strict, bundleHash })}\n`);
  const legacyPath = join(bridge, 'manifest.json');
  const legacy = JSON.parse(readFileSync(legacyPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(legacyPath, `${JSON.stringify({ ...legacy, ...strict, bundleHash })}\n`);
  writeFileSync(join(bridge, SUCCESSION_CAPABILITIES_FILE), `${JSON.stringify({
    version: SUCCESSION_CAPABILITY_VERSION,
    buildSetId: strict.buildSetId,
    bundleHash,
    protocols: ['prepare', 'commit'],
    accepts: [
      { owner: 'durable-cli', generation: 1 },
      { owner: 'child-principals', generation: 1 },
    ],
  })}\n`);
  mkdirSync(join(fixture.root, 'fixtures'));
  copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'gated-durable-cli.cjs'),
    join(fixture.root, 'fixtures', 'gated-durable-cli.cjs'));
  return { ...fixture, bundleHash };
}

function startCli(fixture: PluginFixture, home: string, projectRoot: string, args: string[]) {
  const {
    CORAL_CHILD: _coralChild,
    CORAL_CHILD_PRINCIPAL_HANDLE: _childHandle,
    CORAL_JOB_ID: _jobId,
    CORAL_SESSION_ID: _sessionId,
    ...topLevelEnv
  } = process.env;
  const child = spawn('node', [join(fixture.root, 'bridge', 'coral-cli'), ...args], {
    cwd: projectRoot,
    env: { ...topLevelEnv, HOME: home, TMPDIR: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cliChildren.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const completed = new Promise<number>((resolve, reject) => {
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 90_000);
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (timedOut) reject(new Error(`CLI timed out: ${stdout}\n${stderr}`));
      else resolve(code ?? -1);
    });
  });
  return { stdout: () => stdout, stderr: () => stderr, completed };
}

async function runCli(fixture: PluginFixture, home: string, projectRoot: string, args: string[]): Promise<string> {
  const run = startCli(fixture, home, projectRoot, args);
  const status = await run.completed;
  expect(status, `${run.stdout()}\n${run.stderr()}`).toBe(0);
  return run.stdout();
}

function launchedJobId(output: string): string {
  const jobId = output.match(/Provider job (\S+) (?:launch accepted|queued)/u)?.[1];
  if (jobId === undefined) throw new Error(`Launch reported no job id: ${output}`);
  return jobId;
}

describe('real-process durable-cli succession', () => {
  it('starts the grant-authorized old controller after both unserved participants die', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-grant-recovery-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-grant-recovery-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Keep working through a failed transfer.');
    const oldFixture = await createDurableFixture('0.0.1');
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots,
      env: { CORAL_TEST_SUCCESSION_SERVING_DELAY_MS: '2000' } });
    coordinators.push(old);
    const incumbent = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']));
    const jobState = join(projectRoot, '.durable-state', jobId);
    await waitForCondition(() => existsSync(join(jobState, 'running')), 30_000);
    const providerPid = Number(readFileSync(join(jobState, 'running'), 'utf8'));
    providerChildren.push({ pid: providerPid, incarnation: probeProcessIncarnation(providerPid) });
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const priorGeneration = observeSuccessionWriterGeneration(runtime)?.generation ?? 0;

    const newerFixture = await createDurableFixture('0.0.2');
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000)).toMatchObject({ code: 0 });
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const intent = readUpgradeIntent(runDir);
      return intent.kind === 'readable' && intent.intent.disposition === 'attempting' &&
        intent.intent.attemptChild !== null && intent.intent.attemptChild !== undefined &&
        observeProcessLiveness(intent.intent.attemptChild.pid) === 'alive' &&
        (observeSuccessionWriterGeneration(runtime)?.generation ?? 0) > priorGeneration &&
        (intent.intent.attemptId === null || observeSuccessionServing(runtime, intent.intent.attemptId) === null);
    }, 30_000);
    const pending = readUpgradeIntent(runDir);
    if (pending.kind !== 'readable' || pending.intent.attemptChild === null ||
        pending.intent.attemptChild === undefined) throw new Error('Prepared child is unavailable.');
    const childPid = pending.intent.attemptChild.pid;
    old.child.kill('SIGKILL');
    process.kill(childPid, 'SIGKILL');
    await waitForProcessExit(old, 15_000);
    await waitForCondition(() => observeProcessLiveness(childPid) === 'absent', 15_000);

    const recoveryContender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(recoveryContender);
    expect(await waitForProcessExit(recoveryContender, 30_000)).toMatchObject({ code: 0 });
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery?.version === '0.0.1' && discovery.pid !== incumbent.pid;
    }, 30_000);
    const recovered = readDiscoveryRecordForHome(home, 'prod');
    if (recovered === null) throw new Error('Grant-authorized controller did not start.');
    successors.push({ pid: recovered.pid, incarnation: probeProcessIncarnation(recovered.pid) });
    expect(resolveCurrentStore(runtime).epoch?.epoch).toBe('1');
    expect(new JobLocationIndex(runtime.paths.coral.generation.dataRoot).read(jobId)).not.toBeNull();
  }, 180_000);

  it('hands a live old-format job back to its proven controller before minting', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-schema-handback-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-schema-handback-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Keep working while the controller restarts.');
    const oldFixture = await createDurableFixture('0.0.1');
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
    coordinators.push(old);
    const incumbent = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']));
    const jobState = join(projectRoot, '.durable-state', jobId);
    await waitForCondition(() => existsSync(join(jobState, 'running')), 30_000);
    const providerPid = Number(readFileSync(join(jobState, 'running'), 'utf8'));
    providerChildren.push({ pid: providerPid, incarnation: probeProcessIncarnation(providerPid) });
    const activeRuntime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const admitted = new JobLocationIndex(activeRuntime.paths.coral.generation.dataRoot).read(jobId);
    expect(admitted?.epochKey).toBe(encodeResolvedStoreEpoch(resolveCurrentStore(activeRuntime).epoch!));
    expect(admitted?.controller?.instanceId).toBe(incumbent.instanceId);
    old.child.kill('SIGKILL');
    await waitForProcessExit(old, 15_000);

    const newerFixture = await createDurableFixture('0.0.2',
      'CREATE TABLE ac16_schema_generation (id INTEGER PRIMARY KEY);');
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000)).toMatchObject({ code: 0 });
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery?.version === '0.0.1' && discovery.pid !== incumbent.pid;
    }, 30_000);
    const recovered = readDiscoveryRecordForHome(home, 'prod');
    if (recovered === null) throw new Error('Retained controller did not publish discovery.');
    successors.push({ pid: recovered.pid, incarnation: probeProcessIncarnation(recovered.pid) });
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    expect(resolveCurrentStore(runtime).epoch?.epoch).toBe('1');
    expect(new JobLocationIndex(runtime.paths.coral.generation.dataRoot).read(jobId)?.epochKey).toBe(
      encodeResolvedStoreEpoch(resolveCurrentStore(runtime).epoch!),
    );
  }, 180_000);

  it('indexes an old-format terminal before a no-incumbent mint', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-schema-startup-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-schema-startup-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Finish the old-format job before restart.');
    const oldFixture = await createDurableFixture('0.0.1');
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
    coordinators.push(old);
    await waitForDiscoveryRecord(home, 'prod', 15_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']));
    const jobState = join(projectRoot, '.durable-state', jobId);
    await waitForCondition(() => existsSync(join(jobState, 'running')), 30_000);
    const providerPid = Number(readFileSync(join(jobState, 'running'), 'utf8'));
    providerChildren.push({ pid: providerPid, incarnation: probeProcessIncarnation(providerPid) });
    await runCli(oldFixture, home, projectRoot, ['abort', 'jobs', jobId]);
    await waitForCondition(() => observeProcessLiveness(providerPid) === 'absent', 30_000);
    await stopCoordinator(old);

    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const oldEpoch = resolveCurrentStore(runtime).epoch;
    if (oldEpoch === null) throw new Error('Old epoch was not published.');
    const oldEpochKey = encodeResolvedStoreEpoch(oldEpoch);
    const oldBuild = JSON.parse(readFileSync(join(oldFixture.root, 'bridge',
      CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as { buildSetId: string };
    expect(existsSync(retainedBuildRoot(runtime, oldBuild.buildSetId))).toBe(true);
    const indexRoot = join(runtime.paths.coral.generation.dataRoot, 'job-locations.v1');
    rmSync(join(indexRoot, 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`));
    rmSync(join(indexRoot, 'epochs', Buffer.from(oldEpochKey).toString('base64url'), 'certificate.v1.json'),
      { force: true });

    const newerFixture = await createDurableFixture('0.0.2',
      'CREATE TABLE ac16_schema_generation (id INTEGER PRIMARY KEY);');
    const successor = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(successor);
    await waitForCondition(() => readDiscoveryRecordForHome(home, 'prod')?.version === '0.0.2', 30_000);
    expect(resolveCurrentStore(runtime).epoch?.epoch).toBe('2');
    expect(new JobLocationIndex(runtime.paths.coral.generation.dataRoot).read(jobId)?.disposition).toBe('terminal');
    expect((await runCli(oldFixture, home, projectRoot, ['jobs', 'detail', jobId]))).toMatch(/aborted/iu);
  }, 180_000);

  it('retains an uncertified old epoch when its recovery build is missing', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-schema-unopenable-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-schema-unopenable-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Complete before the old build disappears.');
    const oldFixture = await createDurableFixture('0.0.1');
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
    coordinators.push(old);
    await waitForDiscoveryRecord(home, 'prod', 15_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']));
    const jobState = join(projectRoot, '.durable-state', jobId);
    await waitForCondition(() => existsSync(join(jobState, 'running')), 30_000);
    const providerPid = Number(readFileSync(join(jobState, 'running'), 'utf8'));
    providerChildren.push({ pid: providerPid, incarnation: probeProcessIncarnation(providerPid) });
    await runCli(oldFixture, home, projectRoot, ['abort', 'jobs', jobId]);
    await waitForCondition(() => observeProcessLiveness(providerPid) === 'absent', 30_000);
    await stopCoordinator(old);

    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const oldEpoch = resolveCurrentStore(runtime).epoch;
    if (oldEpoch === null) throw new Error('Old epoch was not published.');
    const oldEpochKey = encodeResolvedStoreEpoch(oldEpoch);
    const oldBuild = JSON.parse(readFileSync(join(oldFixture.root, 'bridge',
      CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as { buildSetId: string };
    const indexRoot = join(runtime.paths.coral.generation.dataRoot, 'job-locations.v1');
    rmSync(join(indexRoot, 'jobs', `${Buffer.from(jobId).toString('base64url')}.json`));
    rmSync(join(indexRoot, 'epochs', Buffer.from(oldEpochKey).toString('base64url'), 'certificate.v1.json'),
      { force: true });
    rmSync(retainedBuildRoot(runtime, oldBuild.buildSetId), { recursive: true, force: true });
    rmSync(oldFixture.root, { recursive: true, force: true });

    const newerFixture = await createDurableFixture('0.0.2',
      'CREATE TABLE ac16_schema_generation (id INTEGER PRIMARY KEY);');
    const first = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(first);
    expect((await waitForProcessExit(first, 30_000)).code).not.toBe(0);
    const second = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(second);
    await waitForCondition(() => readDiscoveryRecordForHome(home, 'prod')?.version === '0.0.2', 30_000);
    expect(resolveCurrentStore(runtime).epoch?.epoch).toBe('2');
    expect(new JobLocationIndex(runtime.paths.coral.generation.dataRoot).read(jobId)?.disposition).toBe('unresolved');
    expect(readEpochClosure(runtime.paths.coral.generation.dataRoot,
      decodeResolvedStoreEpoch(oldEpochKey)!.lineageKey!)?.disposition)
      .toBe('unrecoverable-retained');
  }, 180_000);

  it('serves a new format while a known live old job has no validating controller root', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-schema-live-unopenable-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-schema-live-unopenable-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Remain live while the old controller disappears.');
    const oldFixture = await createDurableFixture('0.0.1');
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
    coordinators.push(old);
    await waitForDiscoveryRecord(home, 'prod', 15_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']));
    const running = join(projectRoot, '.durable-state', jobId, 'running');
    await waitForCondition(() => existsSync(running), 30_000);
    const providerPid = Number(readFileSync(running, 'utf8'));
    providerChildren.push({ pid: providerPid, incarnation: probeProcessIncarnation(providerPid) });
    old.child.kill('SIGKILL');
    await waitForProcessExit(old, 15_000);

    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const oldEpoch = resolveCurrentStore(runtime).epoch;
    if (oldEpoch === null) throw new Error('Old epoch was not published.');
    const oldKey = encodeResolvedStoreEpoch(oldEpoch);
    const oldBuild = JSON.parse(readFileSync(join(oldFixture.root, 'bridge',
      CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as { buildSetId: string };
    rmSync(retainedBuildRoot(runtime, oldBuild.buildSetId), { recursive: true, force: true });
    rmSync(oldFixture.root, { recursive: true, force: true });

    const newerFixture = await createDurableFixture('0.0.2',
      'CREATE TABLE ac16_schema_generation (id INTEGER PRIMARY KEY);');
    const successor = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(successor);
    await waitForCondition(() => readDiscoveryRecordForHome(home, 'prod')?.version === '0.0.2', 30_000);
    expect(resolveCurrentStore(runtime).epoch?.epoch).toBe('2');
    expect(new JobLocationIndex(runtime.paths.coral.generation.dataRoot).read(jobId)).toMatchObject({
      epochKey: oldKey, disposition: 'unresolved',
    });
    expect(readEpochClosure(runtime.paths.coral.generation.dataRoot,
      decodeResolvedStoreEpoch(oldKey)!.lineageKey!)?.disposition).toBe('unrecoverable-retained');
  }, 180_000);

  it.each([
    'CORAL_TEST_RETIREMENT_PROTECTION_FAILURE',
    'CORAL_TEST_RETIREMENT_AUTHORIZATION_FAILURE',
    'CORAL_TEST_RETIREMENT_MINT_FAILURE',
    'CORAL_TEST_RETIREMENT_GENERATION_FAILURE',
    'CORAL_TEST_SUCCESSION_CRASH_BEFORE_SERVING',
  ])('reclaims the old epoch after %s before serving', async (fault) => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-schema-fault-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-schema-fault-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Start after the failed switch.');
    const oldFixture = await createDurableFixture('0.0.1');
    const newerFixture = await createDurableFixture('0.0.2',
      'CREATE TABLE ac16_schema_generation (id INTEGER PRIMARY KEY);');
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots, env: { [fault]: '1' } });
    coordinators.push(old);
    const incumbent = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000)).toMatchObject({ code: 0 });
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const intent = readUpgradeIntent(runDir);
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
      let epoch: ReturnType<typeof resolveCurrentStore>['epoch'];
      try { epoch = resolveCurrentStore(runtime).epoch; } catch { return false; }
      return intent.kind === 'readable' && intent.intent.disposition === 'deferred' &&
        discovery?.pid === incumbent.pid && epoch?.epoch === '1';
    }, 45_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot,
      ['claude', '-i', prompt, '--detach']));
    await runCli(oldFixture, home, projectRoot, ['abort', 'jobs', jobId]);
  }, 180_000);

  it('defers a schema-changing successor until the old job settles and keeps that job addressable', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-schema-succession-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-schema-succession-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Keep the old-format job running.');

    const oldFixture = await createDurableFixture('0.0.1');
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
    coordinators.push(old);
    const incumbent = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']));
    const jobState = join(projectRoot, '.durable-state', jobId);
    await waitForCondition(() => existsSync(join(jobState, 'running')), 30_000);
    const providerPid = Number(readFileSync(join(jobState, 'running'), 'utf8'));
    providerChildren.push({ pid: providerPid, incarnation: probeProcessIncarnation(providerPid) });

    const newerFixture = await createDurableFixture('0.0.2',
      'CREATE TABLE ac16_schema_generation (id INTEGER PRIMARY KEY);');
    const oldFingerprint = JSON.parse(readFileSync(join(oldFixture.root, 'bridge',
      CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as { storeFormatFingerprint: string };
    const newFingerprint = JSON.parse(readFileSync(join(newerFixture.root, 'bridge',
      CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as { storeFormatFingerprint: string };
    expect(newFingerprint.storeFormatFingerprint).not.toBe(oldFingerprint.storeFormatFingerprint);
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000)).toMatchObject({ code: 0 });
    expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(incumbent.pid);
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const intent = readUpgradeIntent(runDir);
      return intent.kind === 'readable' && intent.intent.blockers.some((blocker) =>
        blocker.reason.includes('blocking(format)'));
    }, 30_000);

    await runCli(oldFixture, home, projectRoot, ['abort', 'jobs', jobId]);
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery !== null && discovery.version === '0.0.2' && discovery.pid !== incumbent.pid;
    }, 30_000);
    const successor = readDiscoveryRecordForHome(home, 'prod');
    expect(successor).not.toBeNull();
    successors.push({ pid: successor!.pid, incarnation: probeProcessIncarnation(successor!.pid) });
    const intent = readUpgradeIntent(runDir);
    expect(intent.kind).toBe('readable');
    if (intent.kind !== 'readable') throw new Error('Completed upgrade intent is unavailable.');
    expect(intent.intent.completionReceipt?.epochKey).toContain('"epoch":"2"');
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const servedKey = intent.intent.completionReceipt?.epochKey;
    if (servedKey === undefined || servedKey === null || intent.intent.attemptId === null) {
      throw new Error('Format-changing serving receipt is unavailable.');
    }
    expect(observeSuccessionServing(runtime, intent.intent.attemptId)?.epochKey).toBe(servedKey);
    expect(observeSuccessionWriterGeneration(runtime)?.epoch).toBe('2');
    const originalKey = new JobLocationIndex(runtime.paths.coral.generation.dataRoot).read(jobId)?.epochKey;
    const lineageKey = originalKey === undefined ? undefined : decodeResolvedStoreEpoch(originalKey)?.lineageKey;
    expect(lineageKey).toBeDefined();
    expect(resolveProtectedEpoch(runtime.storage.realpathSync(runtime.paths.coral.store.dbDir),
      lineageKey!)).not.toBeNull();
    expect((await runCli(oldFixture, home, projectRoot, ['jobs', 'detail', jobId]))).toMatch(/aborted/iu);
    const historicalWait = startCli(oldFixture, home, projectRoot, ['wait', 'jobs', jobId]);
    await historicalWait.completed;
    expect(historicalWait.stdout()).toMatch(/aborted/iu);
  }, 180_000);

  it('streams, authorizes its child, cancels, and records the terminal under the immediate successor', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-durable-succession-home-'));
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-durable-succession-work-'));
    roots.push(home, projectRoot);
    mkdirSync(join(home, '.claude'));
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Keep the durable CLI job running.');

    const oldFixture = await createDurableFixture('0.0.1');
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env: { CORAL_MAX_WORKERS: '1' },
    });
    coordinators.push(old);
    const incumbent = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const jobId = launchedJobId(await runCli(oldFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']));
    const jobState = join(projectRoot, '.durable-state', jobId);
    await waitForCondition(() => existsSync(join(jobState, 'running')), 30_000);
    const childPid = Number(readFileSync(join(jobState, 'running'), 'utf8'));
    providerChildren.push({ pid: childPid, incarnation: probeProcessIncarnation(childPid) });
    expect(observeProcessLiveness(childPid)).toBe('alive');
    const waiter = startCli(oldFixture, home, projectRoot, ['wait', 'jobs', jobId]);
    await waitForCondition(() => waiter.stdout().includes('before handover'), 30_000);
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    await waitForCondition(() => {
      const bound = readCustodyLedger(runDir).find((entry) =>
        entry.kind === 'bound' && entry.intent.operationId === jobId);
      if (bound?.kind !== 'bound' || bound.binding.process === null) return false;
      const db = openTestStoreDatabase({
        storeFormat: currentCoralStoreFormat(),
        path: resolveCurrentStore(runtime).path,
        storage: runtime.storage,
        readonly: true,
      });
      try {
        return readDurableCliProcessRuntimeEvidence(db, jobId, bound.binding.process.pid).kind === 'current';
      } finally {
        db.close();
      }
    }, 30_000);

    const newerFixture = await createDurableFixture();
    const oldManifest = JSON.parse(readFileSync(
      join(oldFixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8',
    )) as { storeFormatFingerprint: string };
    const newerManifest = JSON.parse(readFileSync(
      join(newerFixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8',
    )) as { storeFormatFingerprint: string };
    expect(newerManifest.storeFormatFingerprint).toBe(oldManifest.storeFormatFingerprint);
    const contender = spawnCoordinator({
      fixture: newerFixture,
      home,
      tempRoots: roots,
      env: { CORAL_MAX_WORKERS: '1' },
    });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000)).toMatchObject({ code: 0 });
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      const intent = readUpgradeIntent(runDir);
      return discovery !== null && discovery.pid !== incumbent.pid &&
        intent.kind === 'readable' && intent.intent.disposition === 'completed';
    }, 60_000);
    const successor = readDiscoveryRecordForHome(home, 'prod');
    const intent = readUpgradeIntent(runDir);
    if (successor === null || intent.kind !== 'readable' || intent.intent.completionReceipt === null) {
      throw new Error('Durable successor did not publish its serving receipt.');
    }
    successors.push({ pid: successor.pid, incarnation: probeProcessIncarnation(successor.pid) });
    await waitForProcessExit(old, 30_000);
    expect(observeProcessLiveness(successor.pid)).toBe('alive');
    expect(intent.intent.completionReceipt.acceptedObligations).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: 'durable-cli' }),
    ]));
    await waitForCondition(() => readDurableCliControllerReceipts(runDir)
      .some((receipt) => receipt.jobId === jobId), 30_000);
    expect(readDurableCliControllerReceipts(runDir)).toEqual(
      expect.arrayContaining([expect.objectContaining({
        jobId,
        controllerInstanceId: intent.intent.completionReceipt.successor.instanceId,
        controlGeneration: intent.intent.completionReceipt.controlGeneration,
      })]),
    );

    writeFileSync(join(jobState, 'continue'), 'continue');
    await waitForCondition(() => existsSync(join(jobState, 'after-handover')) &&
      waiter.stdout().includes('after handover'), 60_000);
    expect(Number(readFileSync(join(jobState, 'running'), 'utf8'))).toBe(childPid);
    expect(observeProcessLiveness(childPid)).toBe('alive');
    const search = JSON.parse(readFileSync(join(jobState, 'kb-search.json'), 'utf8')) as {
      status: number | null; stdout: string; stderr: string; error?: string;
    };
    expect(search.status, JSON.stringify(search)).toBe(0);

    const queued = await runCli(newerFixture, home, projectRoot, ['claude', '-i', prompt, '--detach']);
    const queuedJobId = launchedJobId(queued);
    expect(queuedJobId).not.toBe(jobId);
    expect(queued).toContain('queued');
    await runCli(newerFixture, home, projectRoot, ['abort', 'jobs', jobId]);
    await waitForCondition(() => existsSync(join(jobState, 'cancelled')), 30_000);
    await waitForCondition(() => observeProcessLiveness(childPid) === 'absent', 30_000);
    await waiter.completed;
    expect(waiter.stdout()).toContain('before handover');
    expect(waiter.stdout()).toContain('after handover');
    expect(waiter.stdout()).toMatch(/abort|cancel/iu);
    expect((await runCli(newerFixture, home, projectRoot, ['jobs', 'detail', jobId]))).toMatch(/aborted/iu);

    const queuedState = join(projectRoot, '.durable-state', queuedJobId);
    await waitForCondition(() => existsSync(join(queuedState, 'running')), 30_000);
    const queuedPid = Number(readFileSync(join(queuedState, 'running'), 'utf8'));
    providerChildren.push({ pid: queuedPid, incarnation: probeProcessIncarnation(queuedPid) });
    await runCli(newerFixture, home, projectRoot, ['abort', 'jobs', queuedJobId]);
    await waitForCondition(() => existsSync(join(queuedState, 'cancelled')), 30_000);
    const queuedWaiter = startCli(newerFixture, home, projectRoot, ['wait', 'jobs', queuedJobId]);
    await queuedWaiter.completed;
    expect(queuedWaiter.stdout()).toMatch(/aborted/iu);
  }, 180_000);
});
