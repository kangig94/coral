import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import {
  handoffCapsuleControllerBuildSetId,
  readHandoffCapsuleFile,
  type RedeemableHandoffCapsule,
} from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  terminateChildProcess,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type PluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';

const roots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const cliChildren: ChildProcess[] = [];
const hostProcesses: { pid: number; incarnation: ProcessIncarnation }[] = [];
const successors: { pid: number; incarnation: ProcessIncarnation | null }[] = [];

/** A probe can race the process it reads, so only an observed incarnation or an absent pid ends the wait. */
async function observedIncarnation(pid: number): Promise<ProcessIncarnation | null> {
  let incarnation: ProcessIncarnation | null = null;
  await waitForCondition(() => {
    incarnation = probeProcessIncarnation(pid);
    return incarnation !== null || observeProcessLiveness(pid) === 'absent';
  }, 10_000);
  return incarnation;
}

afterEach(async () => {
  await Promise.all(cliChildren.splice(0).map((cli) => terminateChildProcess(cli, 'SIGKILL')));
  for (const coordinator of coordinators.splice(0)) await stopCoordinator(coordinator);
  await stopRecordedProcesses(successors.splice(0), 'SIGTERM', 30_000);
  await stopRecordedProcesses(hostProcesses.splice(0), 'SIGKILL', 30_000);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

type TransferWorld = Readonly<{
  home: string;
  projectRoot: string;
  prompt: string;
  state: string;
  env: Record<string, string>;
}>;

function createTransferWorld(): TransferWorld {
  const home = mkdtempSync(join(tmpdir(), 'coral-host-transfer-home-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'coral-host-transfer-work-'));
  roots.push(home, projectRoot);
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  const state = join(home, '.fake-codex-state');
  mkdirSync(state);
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
  );
  copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'transfer-codex-appserver.cjs'), join(binDir, 'codex'));
  chmodSync(join(binDir, 'codex'), 0o755);
  const prompt = join(projectRoot, 'prompt.txt');
  writeFileSync(prompt, 'Keep working while the coordinator is replaced.');
  return { home, projectRoot, prompt, state, env: { PATH: `${binDir}:${process.env.PATH ?? ''}` } };
}

function startCli(fixture: PluginFixture, world: TransferWorld, args: string[]) {
  const {
    CORAL_CHILD: _coralChild,
    CORAL_CHILD_PRINCIPAL_HANDLE: _childHandle,
    CORAL_JOB_ID: _jobId,
    CORAL_SESSION_ID: _sessionId,
    ...topLevelEnv
  } = process.env;
  const child = spawn('node', [join(fixture.root, 'bridge', 'coral-cli'), ...args], {
    cwd: world.projectRoot,
    env: { ...topLevelEnv, HOME: world.home, TMPDIR: world.home, ...world.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cliChildren.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${stdout}\n${stderr}`));
    }, 120_000);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      resolve(code ?? -1);
    });
  });
  return { stdout: () => stdout, output: () => `${stdout}${stderr}`, completed };
}

async function runCli(fixture: PluginFixture, world: TransferWorld, args: string[]): Promise<string> {
  const run = startCli(fixture, world, args);
  const status = await run.completed;
  expect(status, run.output()).toBe(0);
  return run.stdout();
}

function launchedJobId(output: string): string {
  const jobId = output.match(/command=coral-cli wait jobs ([0-9a-f-]{36})\b/u)?.[1];
  if (jobId === undefined) throw new Error(`Launch reported no job id: ${output}`);
  return jobId;
}

function buildSetIdOf(fixture: PluginFixture): string {
  return (
    JSON.parse(readFileSync(join(fixture.root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf8')) as {
      buildSetId: string;
    }
  ).buildSetId;
}

/** The one set the job runs in: its capsule is the durable half of the host's recovery grant. */
function readOnlyCapsule(home: string): Readonly<{ path: string; capsule: RedeemableHandoffCapsule }> | null {
  const runDir = coordinatorFilesForHome(home, 'prod').runDir;
  const paths = existsSync(runDir)
    ? readdirSync(runDir)
        .filter((entry) => /^provider-1[0-9a-f]{23}\.handoff\.v[34]\.json$/u.test(entry))
        .map((entry) => join(runDir, entry))
    : [];
  if (paths.length !== 1) return null;
  const storage = createRealRuntime('prod', { baseDir: join(home, '.coral') }).storage;
  const capsule = readHandoffCapsuleFile(paths[0], { storage, uid: process.getuid?.() ?? 0 });
  return capsule === null || (capsule.version !== 3 && capsule.version !== 4) ? null : { path: paths[0], capsule };
}

function recordHostProcesses(
  capsule: RedeemableHandoffCapsule,
): readonly { pid: number; incarnation: ProcessIncarnation }[] {
  const recorded = [
    { pid: capsule.guardianPid, incarnation: capsule.guardianIncarnation },
    { pid: capsule.reaperPid, incarnation: capsule.reaperIncarnation },
    { pid: capsule.proxyPid, incarnation: capsule.proxyIncarnation },
  ];
  hostProcesses.push(...recorded);
  return recorded;
}

function hostsAlive(recorded: readonly { pid: number; incarnation: ProcessIncarnation }[]): boolean {
  return recorded.every(({ pid, incarnation }) => probeProcessIncarnation(pid) === incarnation);
}

/** Starts the old build, launches one codex job, and waits until it runs inside an independently living host. */
async function startProxiedJob(world: TransferWorld): Promise<
  Readonly<{
    oldFixture: PluginFixture;
    old: SpawnedCoordinator;
    incumbentPid: number;
    jobId: string;
    hosts: readonly { pid: number; incarnation: ProcessIncarnation }[];
    waiter: ReturnType<typeof startCli>;
  }>
> {
  const oldFixture = createPluginFixture(roots, {
    flavor: 'prod',
    version: '0.0.1',
    backend: 'succession-interposition',
    accepts: 'bundled',
  });
  const old = spawnCoordinator({
    fixture: oldFixture,
    home: world.home,
    tempRoots: roots,
    env: world.env,
    supervised: true,
  });
  coordinators.push(old);
  const incumbent = await waitForDiscoveryRecord(world.home, 'prod', 15_000);
  const jobId = launchedJobId(await runCli(oldFixture, world, ['codex', '-i', world.prompt, '--detach']));
  await waitForCondition(() => existsSync(join(world.state, 'job-running')), 60_000);
  let found: ReturnType<typeof readOnlyCapsule> = null;
  await waitForCondition(() => (found = readOnlyCapsule(world.home)) !== null, 30_000);
  if (found === null) throw new Error('The job did not run inside a provider host.');
  const capsule = (found as NonNullable<ReturnType<typeof readOnlyCapsule>>).capsule;
  expect(handoffCapsuleControllerBuildSetId(capsule)).toBe(buildSetIdOf(oldFixture));
  const hosts = recordHostProcesses(capsule);
  const codexPid = Number(readFileSync(join(world.state, 'job-running'), 'utf8'));
  const codexIncarnation = await observedIncarnation(codexPid);
  if (codexIncarnation !== null) hostProcesses.push({ pid: codexPid, incarnation: codexIncarnation });
  const waiter = startCli(oldFixture, world, ['wait', 'jobs', jobId, '--verbose']);
  await waitForCondition(() => waiter.stdout().includes('before-transfer'), 60_000);
  return { oldFixture, old, incumbentPid: incumbent.pid, jobId, hosts, waiter };
}

/** Launches a newer compatible build as contender and waits until it serves as the old build's successor. */
async function upgradeTo(
  world: TransferWorld,
  incumbentPid: number,
): Promise<Readonly<{ newerFixture: PluginFixture; acceptedOwners: readonly string[] }>> {
  const newerFixture = createPluginFixture(roots, {
    flavor: 'prod',
    backend: 'succession-interposition',
    accepts: 'bundled',
  });
  const contender = spawnCoordinator({
    fixture: newerFixture,
    home: world.home,
    tempRoots: roots,
    env: world.env,
    supervised: true,
  });
  coordinators.push(contender);
  const runDir = coordinatorFilesForHome(world.home, 'prod').runDir;
  try {
    expect(await waitForProcessExit(contender, 30_000), contender.output()).toMatchObject({ code: 0 });
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(world.home, 'prod');
      const intent = readUpgradeIntent(runDir);
      return (
        discovery !== null &&
        discovery.pid !== incumbentPid &&
        intent.kind === 'readable' &&
        intent.intent.disposition === 'completed' &&
        intent.intent.completionReceipt?.successor.build.buildSetId === buildSetIdOf(newerFixture)
      );
    }, 30_000);
  } catch (error: unknown) {
    const launch = new SupervisorEvidence(runDir);
    try {
      throw new Error(
        `Provider transfer did not serve: ${JSON.stringify({
          launch: launch.read(),
          intent: readUpgradeIntent(runDir),
          discovery: readDiscoveryRecordForHome(world.home, 'prod'),
          outputs: coordinators.map((coordinator) => coordinator.output()),
        })}`,
        { cause: error },
      );
    } finally {
      launch.close();
    }
  }
  const successor = readDiscoveryRecordForHome(world.home, 'prod');
  const intent = readUpgradeIntent(runDir);
  if (successor === null || intent.kind !== 'readable' || intent.intent.completionReceipt === null) {
    throw new Error('Successor did not serve.');
  }
  successors.push({ pid: successor.pid, incarnation: probeProcessIncarnation(successor.pid) });
  return {
    newerFixture,
    acceptedOwners: intent.intent.completionReceipt.acceptedObligations.map(({ owner }) => owner),
  };
}

async function capsuleNamesController(home: string, fixture: PluginFixture): Promise<void> {
  await waitForCondition(() => {
    const current = readOnlyCapsule(home)?.capsule;
    return current !== undefined && handoffCapsuleControllerBuildSetId(current) === buildSetIdOf(fixture);
  }, 30_000);
}

describe('real-process provider host transfer', () => {
  it('transfers a live host to a compatible build at once and keeps its job through startup recovery', async () => {
    assertBuildArtifactsAvailable();
    const world = createTransferWorld();
    const { oldFixture, incumbentPid, jobId, hosts, waiter } = await startProxiedJob(world);

    expect(existsSync(join(world.home, '.coral', 'gen2', 'builds'))).toBe(false);

    const { newerFixture, acceptedOwners } = await upgradeTo(world, incumbentPid);
    expect(buildSetIdOf(newerFixture)).not.toBe(buildSetIdOf(oldFixture));
    expect(acceptedOwners).toEqual(expect.arrayContaining(['provider-proxy-sets', 'provider-operations']));
    await waitForCondition(() => observeProcessLiveness(incumbentPid) === 'absent', 30_000);

    // The host kept running under the same processes and its own build; only the controller changed.
    expect(hostsAlive(hosts)).toBe(true);
    await capsuleNamesController(world.home, newerFixture);
    expect(readOnlyCapsule(world.home)?.capsule.buildSetId).toBe(buildSetIdOf(oldFixture));

    writeFileSync(join(world.state, 'emit-after-transfer'), 'emit');
    await waitForCondition(() => waiter.stdout().includes('after-transfer'), 60_000);
    writeFileSync(join(world.state, 'release-job'), 'released');
    expect(await waiter.completed, waiter.output()).toBe(0);
    expect(waiter.stdout()).toContain('before-transfer');
    expect(waiter.stdout()).toContain('after-transfer');
    const detail = await runCli(newerFixture, world, ['jobs', 'detail', jobId]);
    expect(detail).toMatch(/completed/iu);
    expect(detail).not.toMatch(/interrupted/iu);
    expect(readFileSync(join(world.home, '.coral', 'exports', 'jobs', jobId, 'result.md'), 'utf8')).toContain('done');
    expect(hostsAlive(hosts)).toBe(true);
    expect(existsSync(join(world.home, '.coral', 'gen2', 'builds'))).toBe(false);
  }, 240_000);
});
