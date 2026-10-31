import { spawn } from 'node:child_process';
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

import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import {
  CORAL_MAX_PROVIDER_PROXY_SETS_ENV,
  CORAL_PROVIDER_PROXY_SET_IDLE_MS_ENV,
} from '#src/coordinator/services/provider-proxy-set/capacity.js';
import { readHandoffCapsuleFile } from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  type PluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { stopRecordedProcesses } from '#tests/support/stop-recorded-processes.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const PROXY_SET_SLOTS = 2;
const roots: string[] = [];
const workDirs: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const codexProcesses: { pid: number; incarnation: ProcessIncarnation | null }[] = [];
const homes: string[] = [];

/** Every proxy set's roles, read from the capsules that record them; a set outlives its coordinator. */
function proxyRoleProcesses(home: string): { pid: number; incarnation: ProcessIncarnation }[] {
  const runDir = coordinatorFilesForHome(home, 'prod').runDir;
  if (!existsSync(runDir)) return [];
  const storage = createRealRuntime('prod', { baseDir: join(home, '.coral') }).storage;
  return readdirSync(runDir)
    .filter((entry) => /^provider-1[0-9a-f]{23}\.handoff\.v[34]\.json$/u.test(entry))
    .flatMap((entry) => {
      const capsule = readHandoffCapsuleFile(join(runDir, entry), { storage, uid: process.getuid?.() ?? 0 });
      if (capsule === null || (capsule.version !== 3 && capsule.version !== 4)) return [];
      return [
        { pid: capsule.guardianPid, incarnation: capsule.guardianIncarnation },
        { pid: capsule.reaperPid, incarnation: capsule.reaperIncarnation },
        { pid: capsule.proxyPid, incarnation: capsule.proxyIncarnation },
      ];
    });
}

afterEach(async () => {
  for (const workDir of workDirs.splice(0)) writeFileSync(join(workDir, 'release'), '');
  const proxyRoles = homes.splice(0).flatMap(proxyRoleProcesses);
  for (const coordinator of coordinators.splice(0)) await stopCoordinator(coordinator);
  await stopRecordedProcesses([...proxyRoles, ...codexProcesses.splice(0)], 'SIGKILL', 30_000);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

type World = Readonly<{ fixture: PluginFixture; home: string; env: Record<string, string> }>;

function createWorld(env: Record<string, string> = {}): World {
  const home = mkdtempSync(join(tmpdir(), 'coral-local-host-home-'));
  roots.push(home);
  homes.push(home);
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
  );
  copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'cwd-gated-codex-appserver.cjs'), join(binDir, 'codex'));
  chmodSync(join(binDir, 'codex'), 0o755);
  return {
    fixture: createPluginFixture(roots, { flavor: 'prod', accepts: 'bundled' }),
    home,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CORAL_BROKER_IDLE_MS: '200',
      [CORAL_MAX_PROVIDER_PROXY_SETS_ENV]: String(PROXY_SET_SLOTS),
      ...env,
    },
  };
}

async function runCli(world: World, cwd: string, args: string[]): Promise<string> {
  const {
    CORAL_CHILD: _coralChild,
    CORAL_CHILD_PRINCIPAL_HANDLE: _childHandle,
    CORAL_JOB_ID: _jobId,
    CORAL_SESSION_ID: _sessionId,
    ...topLevelEnv
  } = process.env;
  const child = spawn('node', [join(world.fixture.root, 'bridge', 'coral-cli'), ...args], {
    cwd,
    env: { ...topLevelEnv, HOME: world.home, TMPDIR: world.home, ...world.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  const status = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
  expect(status, output).toBe(0);
  return output;
}

function parentPid(pid: number): number {
  return Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[1]);
}

/** A provider host runs under its durable wrapper, so the wrapper's parent is the process that owns the host. */
function hostOwnerPid(codexPid: number): number {
  return parentPid(parentPid(codexPid));
}

async function launchHeldJob(world: World): Promise<Readonly<{ workDir: string; jobId: string; codexPid: number }>> {
  const workDir = mkdtempSync(join(tmpdir(), 'coral-local-host-work-'));
  roots.push(workDir);
  workDirs.push(workDir);
  writeFileSync(join(workDir, 'prompt.txt'), 'Hold the turn until released.');
  const output = await runCli(world, workDir, ['codex', '-i', join(workDir, 'prompt.txt'), '--detach']);
  const jobId = output.match(/command=coral-cli jobs wait ([0-9a-f-]{36})\b/u)?.[1];
  if (jobId === undefined) throw new Error(`Launch reported no job id: ${output}`);
  await waitForCondition(() => existsSync(join(workDir, 'running')), 60_000);
  const codexPid = Number(readFileSync(join(workDir, 'running'), 'utf8'));
  codexProcesses.push({ pid: codexPid, incarnation: probeProcessIncarnation(codexPid) });
  return { workDir, jobId, codexPid };
}

describe('coordinator-local provider host retirement', () => {
  it('should retire a local-placement codex host once its finished job is terminal', async () => {
    assertBuildArtifactsAvailable();
    const world = createWorld();
    const coordinator = spawnCoordinator({
      fixture: world.fixture,
      home: world.home,
      tempRoots: roots,
      env: world.env,
    });
    coordinators.push(coordinator);
    const coordinatorPid = (await waitForDiscoveryRecord(world.home, 'prod', 15_000)).pid;

    for (let held = 0; held < PROXY_SET_SLOTS; held += 1) await launchHeldJob(world);
    const local = await launchHeldJob(world);
    expect(hostOwnerPid(local.codexPid), 'every proxy slot is held, so placement falls back locally').toBe(
      coordinatorPid,
    );

    writeFileSync(join(local.workDir, 'release'), '');
    await runCli(world, local.workDir, ['jobs', 'wait', local.jobId]);

    await waitForCondition(() => observeProcessLiveness(local.codexPid) === 'absent', 15_000);
  }, 180_000);
});

describe('provider proxy set retirement', () => {
  it("should return an idle proxy set's slot so the next host is proxied rather than placed locally", async () => {
    assertBuildArtifactsAvailable();
    const world = createWorld({
      [CORAL_MAX_PROVIDER_PROXY_SETS_ENV]: '1',
      [CORAL_PROVIDER_PROXY_SET_IDLE_MS_ENV]: '500',
    });
    const coordinator = spawnCoordinator({
      fixture: world.fixture,
      home: world.home,
      tempRoots: roots,
      env: world.env,
    });
    coordinators.push(coordinator);
    const coordinatorPid = (await waitForDiscoveryRecord(world.home, 'prod', 15_000)).pid;

    const first = await launchHeldJob(world);
    expect(hostOwnerPid(first.codexPid), 'the only slot is free, so the first host is proxied').not.toBe(
      coordinatorPid,
    );
    const firstSet = proxyRoleProcesses(world.home);
    expect(firstSet).not.toHaveLength(0);
    writeFileSync(join(first.workDir, 'release'), '');
    await runCli(world, first.workDir, ['jobs', 'wait', first.jobId]);
    await waitForCondition(() => firstSet.every(({ pid }) => observeProcessLiveness(pid) === 'absent'), 30_000);

    let proxied = false;
    for (let attempt = 0; attempt < 3 && !proxied; attempt += 1) {
      const next = await launchHeldJob(world);
      proxied = hostOwnerPid(next.codexPid) !== coordinatorPid;
      if (proxied) break;
      writeFileSync(join(next.workDir, 'release'), '');
      await runCli(world, next.workDir, ['jobs', 'wait', next.jobId]);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(proxied, 'the idle set returned the only slot').toBe(true);
  }, 180_000);
});
