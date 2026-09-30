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
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { SupervisorEvidence } from '#tests/support/supervisor-evidence.js';
import { supervisorLockPath, v0109CoordinatorSocketGuardSetForRunDir } from '#src/infra/path/coordinator.js';
import { readUpgradeIntent, visibleUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { retainedBuildRoot } from '#src/infra/retained-build-root.js';
import { readHandoffCapsuleFile } from '#src/provider-proxy/handoff-capsule.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { topLevelCliEnvironment } from '#tests/support/top-level-cli-environment.js';
import { readActiveStoreSelectionForCoordination } from '#src/store/active-store-selection.js';
import { probeIncumbent } from '#src/transport/ipc/handoff.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  createShippedPluginFixture,
  materializeFirstReleaseBuild,
  probeCoordinatorSocket,
  readDiscoveryRecordForHome,
  SHIPPED_RELEASE_TAGS,
  shippedCliEnvironment,
  spawnCoordinator,
  stopCoordinator,
  terminateChildProcess,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type PluginFixture,
  type ShippedReleaseTag,
  type ShippedPluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const homes: string[] = [];
const firstReleaseRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const successors: { pid: number; incarnation: ProcessIncarnation }[] = [];
const SHIPPED_IPC_BOUNDARY_PRELOAD = join(
  process.cwd(),
  'tests/integration/coordinator/fixtures/shipped-ipc-boundary.cjs',
);

// A tag may leave this table only in the release that raises the recorded minimum
// predecessor and proves that tag's post-upgrade startup fails softly in a process.
const MINIMUM_SUPPORTED_PREDECESSOR: ShippedReleaseTag = 'v0.10.0';
const SHIPPED_PROTOCOL_GROUPS = [
  { tags: ['v0.10.0'], replacement: 'exact-identity', cli: 'ensure', identity: 'processStartedAt' },
  {
    tags: ['v0.10.1', 'v0.10.2', 'v0.10.3'],
    replacement: 'exact-identity',
    cli: 'ensure',
    identity: 'processStartedAt',
  },
  { tags: ['v0.10.4'], replacement: 'exact-identity', cli: 'prepareTopLevelSpawn', identity: 'processStartedAt' },
  {
    tags: ['v0.10.5', 'v0.10.6', 'v0.10.7', 'v0.10.8'],
    replacement: 'version-precedence',
    cli: 'drain-wait',
    identity: 'processStartedAt',
  },
  { tags: ['v0.10.9'], replacement: 'version-precedence', cli: 'drain-wait', identity: 'incarnation' },
  {
    tags: ['v0.10.10', 'v0.10.11', 'v0.10.12'],
    replacement: 'version-precedence',
    cli: 'drain-wait',
    identity: 'incarnation',
  },
  { tags: ['v0.10.13'], replacement: 'version-precedence', cli: 'executable-bridge', identity: 'incarnation' },
] as const;

const DIRECT_UPGRADE_TAGS = ['v0.10.0', 'v0.10.5', 'v0.10.13'] as const;
// Builds before the v0.10.11 epoch cutover keep jobs in a flat store that later builds never index or read.
const PRE_EPOCH_STORE_TAGS: ReadonlySet<ShippedReleaseTag> = new Set(['v0.10.0', 'v0.10.5']);
const LEGACY_CLI_REPLACEMENT_TAGS = ['v0.10.0', 'v0.10.1', 'v0.10.2', 'v0.10.3', 'v0.10.4'] as const;

afterEach(async () => {
  for (const home of homes.splice(0)) {
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    if (!existsSync(supervisorLockPath(runDir))) continue;
    const launch = new SupervisorEvidence(runDir);
    try {
      const state = launch.read();
      const owner = state.owner?.process;
      if (owner !== undefined && probeProcessIncarnation(owner.pid) === owner.incarnation) {
        try {
          process.kill(owner.pid, 'SIGTERM');
        } catch {
          // The supervisor may have released ownership after the observation.
        }
      }
      for (const child of [state.launch?.child, state.attempt?.child]) {
        if (child === undefined || probeProcessIncarnation(child.pid) !== child.incarnation) continue;
        try {
          process.kill(child.pid, 'SIGTERM');
        } catch {
          // The child may have retired after the observation.
        }
      }
    } finally {
      launch.close();
    }
  }
  for (const successor of successors.splice(0)) {
    if (
      probeProcessIncarnation(successor.pid) === successor.incarnation &&
      observeProcessLiveness(successor.pid) === 'alive'
    )
      process.kill(successor.pid, 'SIGTERM');
  }
  for (const coordinator of coordinators.splice(0).reverse()) await stopCoordinator(coordinator);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'coral-version-pairing-'));
  homes.push(home);
  roots.push(home);
  return home;
}

function rememberSuccessor(pid: number): void {
  const incarnation = probeProcessIncarnation(pid);
  if (incarnation === null) throw new Error(`Successor ${pid} has no process incarnation.`);
  successors.push({ pid, incarnation });
}

async function assertAddressClaimed(socketPath: string): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve();
      else reject(error);
    });
    probe.listen(socketPath, () => {
      probe.close();
      reject(new Error(`Coordinator address was released: ${socketPath}`));
    });
  });
}

function installGatedCodex(home: string): string {
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  mkdirSync(join(home, '.fake-codex-state'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({
      tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' },
    }),
  );
  copyFileSync(join(process.cwd(), 'tests/fixtures/gated-codex-appserver.cjs'), join(binDir, 'codex'));
  chmodSync(join(binDir, 'codex'), 0o755);
  return binDir;
}

async function runShippedStatus(
  tag: ShippedReleaseTag,
  home: string,
): Promise<{ code: number | null; output: string }> {
  const fixture = createShippedPluginFixture(roots, tag);
  const child = spawn(process.execPath, [fixture.cliPath, 'backend', 'status'], {
    cwd: home,
    env: shippedCliEnvironment({ HOME: home, TMPDIR: home, CLAUDE_PLUGIN_ROOT: fixture.root }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Shipped ${tag} CLI timed out: ${output}`));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(deadline);
      resolve(status);
    });
  });
  return { code, output };
}

async function launchShippedJob(
  shipped: ShippedPluginFixture,
  home: string,
  projectRoot: string,
  binDir: string,
  expected: 'completed' | 'running',
): Promise<string> {
  const prompt = join(projectRoot, `prompt-${expected}.txt`);
  writeFileSync(prompt, `${expected} compatibility fixture job.`);
  const child = spawn(process.execPath, [shipped.cliPath, 'codex', '-i', prompt, '-d'], {
    cwd: projectRoot,
    env: shippedCliEnvironment({
      HOME: home,
      TMPDIR: home,
      CLAUDE_PLUGIN_ROOT: shipped.root,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Shipped ${shipped.tag} job launch timed out: ${output}`));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(deadline);
      resolve(status);
    });
  });
  expect(code, output).toBe(0);
  const jobId = output.match(/wait jobs (\S+)/u)?.[1];
  if (jobId === undefined) throw new Error(`Shipped ${shipped.tag} did not launch a job: ${output}`);
  if (expected === 'completed') {
    await waitForCondition(
      () => readdirSync(join(home, '.fake-codex-state')).some((name) => name.startsWith('terminal-')),
      30_000,
    );
    let completed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await readJobDetail(shipped.cliPath, home, projectRoot, jobId)).includes('Phase: completed')) {
        completed = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(completed).toBe(true);
  } else {
    await waitForCondition(() => existsSync(join(home, '.fake-codex-state', 'job-running')), 30_000);
  }
  return jobId;
}

async function readJobDetail(cliPath: string, home: string, projectRoot: string, jobId: string): Promise<string> {
  const { code, output } = await runJobDetail(cliPath, home, projectRoot, jobId);
  expect(code, output).toBe(0);
  return output;
}

async function expectPreEpochHistory(cliPath: string, home: string, projectRoot: string, jobId: string): Promise<void> {
  const { code, output } = await runJobDetail(cliPath, home, projectRoot, jobId);
  expect(code, output).not.toBe(0);
  expect(output).toContain('job_pre_epoch_history');
  expect(output).toContain(jobId);
}

async function runJobDetail(
  cliPath: string,
  home: string,
  projectRoot: string,
  jobId: string,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [cliPath, 'jobs', 'detail', jobId], {
    cwd: projectRoot,
    env: shippedCliEnvironment({ HOME: home, TMPDIR: home, CLAUDE_PLUGIN_ROOT: dirname(dirname(cliPath)) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Historical job detail timed out: ${output}`));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(deadline);
      resolve(status);
    });
  });
  return { code, output };
}

describe('AC18 first-release version pairing', () => {
  it('keeps every shipped predecessor in the pairing window', () => {
    expect(MINIMUM_SUPPORTED_PREDECESSOR).toBe('v0.10.0');
    expect(SHIPPED_PROTOCOL_GROUPS.flatMap((group) => group.tags)).toEqual(SHIPPED_RELEASE_TAGS);
    expect(new Set(DIRECT_UPGRADE_TAGS).size).toBe(3);
  });

  it.each(SHIPPED_RELEASE_TAGS)(
    'lets a running %s incumbent serve after a newer contender arrives',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const shipped = createShippedPluginFixture(roots, tag);
      const incumbent = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      expect(initial.version).toBe(shipped.version);

      const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const contender = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
      coordinators.push(contender);
      expect(await waitForProcessExit(contender, 30_000), contender.output()).toEqual({ code: 0, signal: null });
      expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);
      expect(incumbent.child.exitCode).toBeNull();
      expect(await probeCoordinatorSocket(initial.socketPath)).toBe('accepting');
      const launch = new SupervisorEvidence(coordinatorFilesForHome(home, 'prod').runDir);
      try {
        expect(launch.read().requests).toContainEqual(
          expect.objectContaining({
            executable: join(branch.root, 'bridge', 'coral-backend.cjs'),
            status: 'accepted',
            incumbent: expect.objectContaining({ pid: incumbent.child.pid }),
          }),
        );
      } finally {
        launch.close();
      }
    },
    45_000,
  );

  it.each(DIRECT_UPGRADE_TAGS)(
    'leaves a starting %s incumbent in control',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const marker = join(home, 'shipped-ipc-bound');
      const shipped = createShippedPluginFixture(roots, tag);
      const incumbent = spawnCoordinator({
        fixture: shipped,
        home,
        tempRoots: roots,
        env: {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${SHIPPED_IPC_BOUNDARY_PRELOAD}`,
          CORAL_TEST_SHIPPED_IPC_BOUNDARY: 'starting',
          CORAL_TEST_SHIPPED_IPC_MARKER: marker,
          CORAL_TEST_SHIPPED_IPC_DELAY_MS: '5000',
        },
      });
      coordinators.push(incumbent);
      await waitForCondition(() => existsSync(marker), 20_000);

      const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const contender = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
      coordinators.push(contender);
      expect(await waitForProcessExit(contender, 30_000)).toEqual({ code: 0, signal: null });
      const serving = await waitForDiscoveryRecord(home, 'prod', 20_000);
      expect(serving.version).toBe(shipped.version);
      expect(serving.bundleHash).toBe(shipped.bundleHash);
      expect(await probeCoordinatorSocket(serving.socketPath)).toBe('accepting');
      const launch = new SupervisorEvidence(coordinatorFilesForHome(home, 'prod').runDir);
      try {
        await waitForCondition(() => launch.read().owner !== null, 5_000);
        expect(launch.read()).toMatchObject({ owner: { process: { pid: expect.any(Number) } } });
        expect(launch.read().requests).toContainEqual(
          expect.objectContaining({
            executable: join(branch.root, 'bridge', 'coral-backend.cjs'),
            status: 'accepted',
            incumbent: expect.objectContaining({ pid: incumbent.child.pid }),
          }),
        );
      } finally {
        launch.close();
      }
    },
    55_000,
  );

  it('records the supervisor request only once a starting shipped incumbent publishes discovery', async () => {
    assertBuildArtifactsAvailable();
    const home = newHome();
    const marker = join(home, 'shipped-ipc-bound');
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const incumbent = spawnCoordinator({
      fixture: shipped,
      home,
      tempRoots: roots,
      env: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${SHIPPED_IPC_BOUNDARY_PRELOAD}`,
        CORAL_TEST_SHIPPED_IPC_BOUNDARY: 'starting',
        CORAL_TEST_SHIPPED_IPC_MARKER: marker,
        CORAL_TEST_SHIPPED_IPC_DELAY_MS: '12000',
      },
    });
    coordinators.push(incumbent);
    await waitForCondition(() => existsSync(marker), 20_000);
    expect(readDiscoveryRecordForHome(home, 'prod')).toBeNull();

    const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const supervisor = spawnCoordinator({ fixture: branch, home, tempRoots: roots, supervised: true });
    coordinators.push(supervisor);
    const launch = new SupervisorEvidence(coordinatorFilesForHome(home, 'prod').runDir);
    try {
      // The bound socket names nobody yet, so no request may be written under an invented incumbent.
      await waitForCondition(() => launch.lockHolder()?.pid !== undefined, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(readDiscoveryRecordForHome(home, 'prod')).toBeNull();
      expect(readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir).kind).toBe('absent');
      expect(supervisor.child.exitCode).toBeNull();
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      expect(initial.pid).toBe(incumbent.child.pid);
      await waitForCondition(
        () =>
          launch
            .read()
            .requests.some(
              (request) =>
                request.executable === join(branch.root, 'bridge', 'coral-backend.cjs') &&
                request.status === 'accepted' &&
                request.incumbent.pid === incumbent.child.pid,
            ),
        10_000,
      );
      await stopCoordinator(incumbent);
      await waitForCondition(() => {
        const current = readDiscoveryRecordForHome(home, 'prod');
        return current !== null && current.pid !== initial.pid && current.bundleHash === branch.bundleHash;
      }, 40_000);
      const successor = readDiscoveryRecordForHome(home, 'prod');
      if (successor === null) throw new Error('Supervisor request did not reach a successor.');
      rememberSuccessor(successor.pid);
      await waitForCondition(() => launch.read().requests.some((request) => request.status === 'completed'), 10_000);
    } finally {
      launch.close();
    }
  }, 90_000);

  it('watches a serving shipped incumbent before the first launch, then launches the legacy retirement', async () => {
    assertBuildArtifactsAvailable();
    const home = newHome();
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const incumbent = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
    coordinators.push(incumbent);
    await waitForDiscoveryRecord(home, 'prod', 20_000);

    const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const contender = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
    coordinators.push(contender);
    const launch = new SupervisorEvidence(coordinatorFilesForHome(home, 'prod').runDir);
    try {
      expect(await waitForProcessExit(contender, 30_000), contender.output()).toEqual({ code: 0, signal: null });
      expect(launch.read().requests).toContainEqual(
        expect.objectContaining({
          status: 'accepted',
          incumbent: expect.objectContaining({ pid: incumbent.child.pid }),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(launch.read().launch).toBeNull();

      await stopCoordinator(incumbent);
      await waitForCondition(() => launch.read().launch?.phase === 'serving', 40_000);
      expect(launch.read().launch).toMatchObject({ purpose: 'legacy-retirement' });
      const successor = readDiscoveryRecordForHome(home, 'prod');
      if (successor === null) throw new Error('Legacy retirement did not reach a successor.');
      rememberSuccessor(successor.pid);
      expect(successor.bundleHash).toBe(branch.bundleHash);
    } finally {
      launch.close();
    }
  }, 90_000);

  it('refuses a shipped contender while the newer incumbent is starting', async () => {
    assertBuildArtifactsAvailable();
    const home = newHome();
    const marker = join(home, 'new-ipc-bound');
    const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const incumbent = spawnCoordinator({
      fixture: branch,
      home,
      tempRoots: roots,
      env: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${SHIPPED_IPC_BOUNDARY_PRELOAD}`,
        CORAL_TEST_SHIPPED_IPC_BOUNDARY: 'starting',
        CORAL_TEST_SHIPPED_IPC_MARKER: marker,
        CORAL_TEST_SHIPPED_IPC_DELAY_MS: '8000',
        CORAL_TEST_SHIPPED_IPC_SOCKET: join(home, '.coral', 'run', 'coordinator.sock'),
      },
    });
    coordinators.push(incumbent);
    await waitForCondition(() => existsSync(marker), 20_000);

    const shipped = createShippedPluginFixture(roots, 'v0.10.0');
    const contender = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
    coordinators.push(contender);
    try {
      await waitForProcessExit(contender, 35_000);
    } catch (error) {
      console.error(`Shipped contender output: ${contender.output()}`);
      throw error;
    }
    const serving = await waitForDiscoveryRecord(home, 'prod', 20_000);
    expect(serving.version).toBe('0.10.14');
    expect(serving.pid).toBe(incumbent.child.pid);
    expect(await probeCoordinatorSocket(serving.socketPath)).toBe('accepting');
  }, 65_000);

  it.each(DIRECT_UPGRADE_TAGS)(
    'waits for a draining %s incumbent to release its socket',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const marker = join(home, 'shipped-ipc-closing');
      const shipped = createShippedPluginFixture(roots, tag);
      const incumbent = spawnCoordinator({
        fixture: shipped,
        home,
        tempRoots: roots,
        env: {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${SHIPPED_IPC_BOUNDARY_PRELOAD}`,
          CORAL_TEST_SHIPPED_IPC_BOUNDARY: 'draining',
          CORAL_TEST_SHIPPED_IPC_MARKER: marker,
          CORAL_TEST_SHIPPED_IPC_DELAY_MS: '3000',
        },
      });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      const shutdown = spawn(process.execPath, [shipped.cliPath, 'backend', 'shutdown'], {
        cwd: home,
        env: shippedCliEnvironment({ HOME: home, TMPDIR: home, CLAUDE_PLUGIN_ROOT: shipped.root }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      shutdown.stdout.resume();
      shutdown.stderr.resume();
      try {
        await waitForCondition(() => existsSync(marker), 20_000);
        expect((await probeIncumbent({ socketPath: initial.socketPath, timeoutMs: 1_000 }))?.status).toBe('draining');
        const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
        const contender = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
        coordinators.push(contender);
        await waitForCondition(() => {
          const current = readDiscoveryRecordForHome(home, 'prod');
          return current !== null && current.pid !== initial.pid && current.bundleHash === branch.bundleHash;
        }, 40_000);
        const serving = readDiscoveryRecordForHome(home, 'prod');
        if (serving === null) throw new Error('Contender did not serve after administrative drain.');
        expect(serving.pid).toBe(contender.child.pid);
        expect(await probeCoordinatorSocket(serving.socketPath)).toBe('accepting');
      } finally {
        await terminateChildProcess(shutdown, 'SIGTERM');
      }
    },
    70_000,
  );

  it.each(DIRECT_UPGRADE_TAGS)(
    'upgrades directly from %s after the legacy incumbent retires naturally',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const projectRoot = mkdtempSync(join(tmpdir(), 'coral-shipped-upgrade-job-'));
      roots.push(projectRoot);
      const binDir = installGatedCodex(home);
      writeFileSync(join(home, '.fake-codex-state', 'release-job'), 'released');
      const shipped = createShippedPluginFixture(roots, tag);
      const incumbent = spawnCoordinator({
        fixture: shipped,
        home,
        tempRoots: roots,
        // A supervisor observation must not renew the shipped incumbent's idle timer.
        env: { CORAL_BACKEND_IDLE_MS: '3000', PATH: `${binDir}:${process.env.PATH ?? ''}` },
      });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      const completedJobId = await launchShippedJob(shipped, home, projectRoot, binDir, 'completed');
      const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const contender = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
      coordinators.push(contender);
      expect(await waitForProcessExit(contender, 30_000)).toEqual({ code: 0, signal: null });
      expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);

      await waitForProcessExit(incumbent, 90_000);
      try {
        await waitForCondition(() => {
          const current = readDiscoveryRecordForHome(home, 'prod');
          return current !== null && current.pid !== initial.pid && current.bundleHash === branch.bundleHash;
        }, 60_000);
      } catch (error: unknown) {
        const record = new SupervisorEvidence(coordinatorFilesForHome(home, 'prod').runDir);
        try {
          throw new Error(`Legacy upgrade did not serve; launch=${JSON.stringify(record.read())}`, { cause: error });
        } finally {
          record.close();
        }
      }
      const successor = readDiscoveryRecordForHome(home, 'prod');
      if (successor === null) throw new Error('Direct-upgrade successor has no discovery record.');
      rememberSuccessor(successor.pid);
      expect(await probeCoordinatorSocket(successor.socketPath)).toBe('accepting');
      await waitForCondition(
        () => existsSync(join(home, '.coral', 'exports', 'jobs', completedJobId, 'result.md')),
        30_000,
      );
      expect(readFileSync(join(home, '.coral', 'exports', 'jobs', completedJobId, 'result.md'), 'utf8')).toContain(
        'done',
      );
      const branchCli = join(branch.root, 'bridge', 'coral-cli');
      if (PRE_EPOCH_STORE_TAGS.has(tag)) {
        await expectPreEpochHistory(branchCli, home, projectRoot, completedJobId);
      } else {
        const detail = await readJobDetail(branchCli, home, projectRoot, completedJobId);
        expect(detail).toContain(`Job ${completedJobId}`);
        expect(detail).toContain('Phase: completed');
      }
      const launch = new SupervisorEvidence(coordinatorFilesForHome(home, 'prod').runDir);
      try {
        await waitForCondition(
          () =>
            launch
              .read()
              .requests.some(
                (request) =>
                  request.executable === join(branch.root, 'bridge', 'coral-backend.cjs') &&
                  request.status === 'completed',
              ),
          20_000,
        );
        expect(launch.read().requests).toContainEqual(
          expect.objectContaining({
            executable: join(branch.root, 'bridge', 'coral-backend.cjs'),
            status: 'completed',
          }),
        );
      } finally {
        launch.close();
      }
    },
    210_000,
  );

  it.each(DIRECT_UPGRADE_TAGS)(
    'addresses completed and live or unresolved %s jobs after a direct crash upgrade',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const projectRoot = mkdtempSync(join(tmpdir(), 'coral-shipped-crash-jobs-'));
      roots.push(projectRoot);
      const binDir = installGatedCodex(home);
      const state = join(home, '.fake-codex-state');
      writeFileSync(join(state, 'release-job'), 'released');
      const shipped = createShippedPluginFixture(roots, tag);
      const incumbent = spawnCoordinator({
        fixture: shipped,
        home,
        tempRoots: roots,
        env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      const completedJobId = await launchShippedJob(shipped, home, projectRoot, binDir, 'completed');
      rmSync(join(state, 'release-job'), { force: true });
      rmSync(join(state, 'job-running'), { force: true });
      let liveProviderPid: number | null = null;
      try {
        const liveJobId = await launchShippedJob(shipped, home, projectRoot, binDir, 'running');
        liveProviderPid = Number(readFileSync(join(state, 'job-running'), 'utf8'));
        incumbent.child.kill('SIGKILL');
        await waitForProcessExit(incumbent, 20_000);
        const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
        const recovery = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
        coordinators.push(recovery);
        await waitForCondition(() => {
          const current = readDiscoveryRecordForHome(home, 'prod');
          return (
            (current !== null && current.pid !== initial.pid) ||
            recovery.child.exitCode !== null ||
            recovery.child.signalCode !== null
          );
        }, 45_000);
        const serving = readDiscoveryRecordForHome(home, 'prod');
        if (serving === null || serving.pid === initial.pid) {
          throw new Error(
            `The first recovery coordinator after a direct crash upgrade did not serve ` +
              `(exit=${recovery.child.exitCode}, signal=${recovery.child.signalCode}).\n${recovery.output()}`,
          );
        }
        rememberSuccessor(serving.pid);
        const branchCli = join(branch.root, 'bridge', 'coral-cli');
        if (PRE_EPOCH_STORE_TAGS.has(tag)) {
          await expectPreEpochHistory(branchCli, home, projectRoot, completedJobId);
          await expectPreEpochHistory(branchCli, home, projectRoot, liveJobId);
          expect(liveProviderPid).not.toBeNull();
          expect(observeProcessLiveness(liveProviderPid ?? 0)).toBe('alive');
        } else {
          const completed = await readJobDetail(branchCli, home, projectRoot, completedJobId);
          expect(completed).toContain(`Job ${completedJobId}`);
          expect(completed).toContain('Phase: completed');
          const liveOrUnresolved = await readJobDetail(branchCli, home, projectRoot, liveJobId);
          expect(liveOrUnresolved).toContain(`Job ${liveJobId}`);
          expect(liveOrUnresolved).not.toMatch(/jobs?_not_found/u);
        }
      } finally {
        writeFileSync(join(state, 'release-job'), 'released');
        if (liveProviderPid !== null && observeProcessLiveness(liveProviderPid) === 'alive') {
          process.kill(liveProviderPid, 'SIGKILL');
        }
      }
    },
    240_000,
  );

  it('keeps the newer selection when an older build is launched after its coordinator exits', async () => {
    assertBuildArtifactsAvailable();
    const home = newHome();
    const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const newer = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
    coordinators.push(newer);
    const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
    await stopCoordinator(newer);

    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const older = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
    coordinators.push(older);
    await waitForCondition(() => {
      const current = readDiscoveryRecordForHome(home, 'prod');
      return current !== null && current.pid !== initial.pid && current.bundleHash === branch.bundleHash;
    }, 40_000);
    const serving = readDiscoveryRecordForHome(home, 'prod');
    if (serving === null) throw new Error('Selected newer build has no discovery record.');
    rememberSuccessor(serving.pid);
    expect(serving.version).toBe('0.10.14');
    expect(await probeCoordinatorSocket(serving.socketPath)).toBe('accepting');
  }, 60_000);

  it('lets an older build take rollback only after the selected newer root stops validating', async () => {
    assertBuildArtifactsAvailable();
    const home = newHome();
    const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const newer = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
    coordinators.push(newer);
    await waitForDiscoveryRecord(home, 'prod', 20_000);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const selected = readActiveStoreSelectionForCoordination(runtime);
    if (selected.kind !== 'valid') throw new Error(`Newer build did not publish a selection: ${selected.kind}`);
    expect(selected.selection.manifest.version).toBe('0.10.14');
    await stopCoordinator(newer);
    rmSync(dirname(selected.selection.bundleDir), { recursive: true, force: true });

    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const rollback = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
    coordinators.push(rollback);
    await waitForCondition(() => readDiscoveryRecordForHome(home, 'prod')?.version === '0.10.13', 20_000);
    const serving = readDiscoveryRecordForHome(home, 'prod');
    if (serving === null) throw new Error('Rollback coordinator has no discovery record.');
    expect(serving.version).toBe('0.10.13');
    expect(serving.bundleHash).toBe(shipped.bundleHash);
    expect(await probeCoordinatorSocket(serving.socketPath)).toBe('accepting');
  }, 50_000);

  it('lets the older build take rollback after a completed upgrade once the successor root stops validating', async () => {
    assertBuildArtifactsAvailable();
    const home = newHome();
    const older = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const incumbent = spawnCoordinator({ fixture: older, home, tempRoots: roots, supervised: true });
    coordinators.push(incumbent);
    const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
    const newer = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15' });
    const contender = spawnCoordinator({ fixture: newer, home, tempRoots: roots, supervised: true });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000)).toEqual({ code: 0, signal: null });
    await waitForCondition(() => {
      const current = readDiscoveryRecordForHome(home, 'prod');
      const intent = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
      return (
        current !== null &&
        current.pid !== initial.pid &&
        current.bundleHash === newer.bundleHash &&
        intent.kind === 'readable' &&
        intent.intent.disposition === 'completed'
      );
    }, 60_000);
    const successor = readDiscoveryRecordForHome(home, 'prod');
    if (successor === null) throw new Error('Completed upgrade has no serving successor.');
    await waitForCondition(() => observeProcessLiveness(initial.pid) === 'absent', 30_000);
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const selected = readActiveStoreSelectionForCoordination(runtime);
    if (selected.kind !== 'valid') throw new Error(`Completed upgrade selection is ${selected.kind}`);
    incumbent.child.kill('SIGSTOP');
    process.kill(successor.pid, 'SIGTERM');
    incumbent.child.kill('SIGKILL');
    await waitForProcessExit(incumbent, 15_000);
    await waitForCondition(() => observeProcessLiveness(successor.pid) === 'absent', 30_000);
    rmSync(newer.root, { recursive: true, force: true });
    rmSync(retainedBuildRoot(runtime, selected.selection.manifest.buildSetId), { recursive: true, force: true });

    const rollback = spawnCoordinator({ fixture: older, home, tempRoots: roots, supervised: true });
    coordinators.push(rollback);
    await waitForCondition(() => {
      const current = readDiscoveryRecordForHome(home, 'prod');
      return current !== null && current.pid !== successor.pid && current.bundleHash === older.bundleHash;
    }, 30_000).catch((error: unknown) => {
      throw new Error(`Older build did not take rollback: ${rollback.output()}`, { cause: error });
    });
    const serving = readDiscoveryRecordForHome(home, 'prod');
    expect(serving?.bundleHash).toBe(older.bundleHash);
    expect(await probeCoordinatorSocket(serving?.socketPath ?? '')).toBe('accepting');
  }, 150_000);

  it.each(SHIPPED_RELEASE_TAGS)(
    'refuses a %s contender while a newer incumbent serves',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const incumbent = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      const shipped = createShippedPluginFixture(roots, tag);
      const contender = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
      coordinators.push(contender);
      // v0.10.0-v0.10.8 contenders cannot verify a differently rooted incumbent's discovery record and exit only
      // when their own 30s handoff budget (HANDOFF_DRAIN_TIMEOUT_MS in those tags) expires.
      await waitForProcessExit(contender, 45_000);
      expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);
      expect(incumbent.child.exitCode).toBeNull();
      expect(await probeCoordinatorSocket(initial.socketPath)).toBe('accepting');
    },
    70_000,
  );

  it.each(LEGACY_CLI_REPLACEMENT_TAGS)(
    'lets the %s CLI reach the newer incumbent without replacing it',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const incumbent = spawnCoordinator({ fixture: branch, home, tempRoots: roots });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      const result = await runShippedStatus(tag, home);
      expect(result.code).not.toBeNull();
      expect(result.output.length).toBeGreaterThan(0);
      expect(result.output).toMatch(/0\.10\.14|shutdown_unauthorized|incumbent rejected shutdown capability/u);
      expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);
      expect(await probeCoordinatorSocket(initial.socketPath)).toBe('accepting');
    },
    45_000,
  );

  it.each(['v0.10.0', 'v0.10.4'] as const)(
    'routes a %s CLI-spawned contender to a serving coordinator during commit',
    async (tag) => {
      assertBuildArtifactsAvailable();
      const home = newHome();
      const incumbentFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
      const older = createShippedPluginFixture(roots, 'v0.10.13');
      const incumbent = spawnCoordinator({
        fixture: incumbentFixture,
        home,
        tempRoots: roots,
        // A delay past the successor's serving deadline self-fences the attempt; see SUCCESSION_PAUSE_ATTEMPT_MS.
        env: { CORAL_TEST_SUCCESSION_SERVING_DELAY_MS: '2000' },
        supervised: true,
      });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      // Only the interposition backend honors the serving delay the incumbent's environment hands its successor.
      const successorFixture = createPluginFixture(roots, {
        flavor: 'prod',
        version: '0.10.15',
        backend: 'succession-interposition',
      });
      const contender = spawnCoordinator({ fixture: successorFixture, home, tempRoots: roots, supervised: true });
      coordinators.push(contender);
      await waitForCondition(() => {
        const observed = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
        return observed.kind === 'readable' && visibleUpgradeIntent(observed.intent)?.phase === 'prepared';
      }, 30_000);
      expect(contender.child.exitCode).toBeNull();

      // The commit window closes at the successor's serving deadline, so the legacy arrivals must overlap it.
      try {
        await waitForCondition(() => {
          const observed = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
          return observed.kind === 'readable' && observed.intent.disposition === 'attempting';
        }, 30_000);
      } catch (error: unknown) {
        const runDir = coordinatorFilesForHome(home, 'prod').runDir;
        const launch = new SupervisorEvidence(runDir);
        const state = launch.read();
        launch.close();
        throw new Error(
          `Commit did not start: ${JSON.stringify({ intent: readUpgradeIntent(runDir), launch: state, incumbent: incumbent.output(), contender: contender.output() })}`,
          { cause: error },
        );
      }
      const olderContender = spawnCoordinator({ fixture: older, home, tempRoots: roots });
      coordinators.push(olderContender);
      expect(readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir)).toMatchObject({
        kind: 'readable',
        intent: { successionPreparation: { stage: 'ready' } },
      });

      const paths = coordinatorFilesForHome(home, 'prod');
      const guards = v0109CoordinatorSocketGuardSetForRunDir(paths.runDir, 'prod', {
        platform: process.platform,
        configuredTempDirectory: home,
        systemTempDirectory: home,
      });
      if (guards.kind === 'address-unenumerable') throw new Error('Coordinator guard addresses are unenumerable.');
      const addresses = [...new Set([initial.socketPath, paths.socketPath, ...guards.paths])];
      let sampling = true;
      const addressSamples = (async () => {
        while (sampling) {
          for (const address of addresses) await assertAddressClaimed(address);
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      })();
      try {
        const cli = await runShippedStatus(tag, home);
        expect(cli.code).not.toBeNull();
        expect(cli.output).toMatch(/0\.10\.14|0\.10\.15|shutdown_unauthorized|incumbent rejected shutdown capability/u);
        expect([incumbentFixture.bundleHash, successorFixture.bundleHash]).toContain(
          readDiscoveryRecordForHome(home, 'prod')?.bundleHash,
        );
        await waitForCondition(() => {
          const current = readDiscoveryRecordForHome(home, 'prod');
          return current !== null && current.pid !== initial.pid && current.bundleHash === successorFixture.bundleHash;
        }, 60_000);
        const serving = readDiscoveryRecordForHome(home, 'prod');
        if (serving === null) throw new Error('Committed successor has no discovery record.');
        rememberSuccessor(serving.pid);
        expect(await probeCoordinatorSocket(serving.socketPath)).toBe('accepting');
        // The successor publishes discovery before the incumbent records the completion it acknowledges.
        await waitForCondition(() => {
          const observed = readUpgradeIntent(paths.runDir);
          return observed.kind === 'readable' && observed.intent.disposition === 'completed';
        }, 30_000);
      } finally {
        sampling = false;
        await addressSamples;
      }
      expect(await waitForProcessExit(contender, 30_000)).toEqual({ code: 0, signal: null });
      await waitForProcessExit(olderContender, 30_000);
      expect(readDiscoveryRecordForHome(home, 'prod')?.version).not.toBe(older.version);
    },
    100_000,
  );
});

type HostedWork = Readonly<{
  home: string;
  projectRoot: string;
  binDir: string;
  hosts: readonly { pid: number; incarnation: ProcessIncarnation }[];
}>;

const hostProcesses: { pid: number; incarnation: ProcessIncarnation }[] = [];

/** Recorded host processes are not this test's children, so only their incarnation disappearing proves an exit. */
afterEach(async () => {
  const signalled = hostProcesses
    .splice(0)
    .filter(
      ({ pid, incarnation }) => probeProcessIncarnation(pid) === incarnation && observeProcessLiveness(pid) === 'alive',
    );
  for (const { pid } of signalled) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // A process that exited after it was observed is what the wait below confirms.
    }
  }
  await waitForCondition(
    () => signalled.every(({ pid, incarnation }) => probeProcessIncarnation(pid) !== incarnation),
    30_000,
  );
});

function installTransferCodex(home: string): string {
  const binDir = join(home, 'bin');
  mkdirSync(binDir);
  mkdirSync(join(home, '.fake-codex-state'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
  );
  copyFileSync(join(process.cwd(), 'tests/fixtures/transfer-codex-appserver.cjs'), join(binDir, 'codex'));
  chmodSync(join(binDir, 'codex'), 0o755);
  return binDir;
}

async function runFixtureCli(
  pluginRoot: string,
  work: Pick<HostedWork, 'home' | 'projectRoot' | 'binDir'>,
  args: readonly string[],
): Promise<string> {
  const child = spawn(process.execPath, [join(pluginRoot, 'bridge', 'coral-cli'), ...args], {
    cwd: work.projectRoot,
    env: topLevelCliEnvironment(work.home, {
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      PATH: `${work.binDir}:${process.env.PATH ?? ''}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI ${args.join(' ')} timed out: ${output}`));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(deadline);
      resolve(status);
    });
  });
  expect(code, output).toBe(0);
  return output;
}

/** The processes of the one host set whose capsule the incumbent published, of whatever capsule generation. */
function readHostProcesses(home: string): readonly { pid: number; incarnation: ProcessIncarnation }[] | null {
  const runDir = coordinatorFilesForHome(home, 'prod').runDir;
  if (!existsSync(runDir)) return null;
  const paths = readdirSync(runDir).filter((entry) =>
    /^provider-1[0-9a-f]{23}\.handoff(?:\.v\d+)?\.json$/u.test(entry),
  );
  if (paths.length !== 1) return null;
  const storage = createRealRuntime('prod', { baseDir: join(home, '.coral') }).storage;
  const capsule = readHandoffCapsuleFile(join(runDir, paths[0]), { storage, uid: process.getuid?.() ?? 0 });
  if (capsule === null || (capsule.version !== 3 && capsule.version !== 4)) return null;
  return [
    { pid: capsule.guardianPid, incarnation: capsule.guardianIncarnation },
    { pid: capsule.reaperPid, incarnation: capsule.reaperIncarnation },
    { pid: capsule.proxyPid, incarnation: capsule.proxyIncarnation },
  ];
}

function hostsAlive(hosts: readonly { pid: number; incarnation: ProcessIncarnation }[]): boolean {
  return hosts.every(({ pid, incarnation }) => probeProcessIncarnation(pid) === incarnation);
}

async function waitForJobPhase(pluginRoot: string, work: HostedWork, jobId: string, phase: string): Promise<void> {
  let detail = '';
  for (let attempt = 0; attempt < 300; attempt++) {
    detail = await runFixtureCli(pluginRoot, work, ['jobs', 'detail', jobId]);
    if (detail.includes(`Phase: ${phase}`)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Job ${jobId} never reached ${phase}: ${detail}`);
}

/**
 * Starts `incumbentRoot`'s coordinator and leaves one gated codex job running inside a provider host. A warm-up
 * job goes first because a build may run the job that starts a host set outside it.
 */
async function startHostedJob(incumbentRoot: PluginFixture): Promise<HostedWork & { jobId: string; pid: number }> {
  const home = newHome();
  const projectRoot = mkdtempSync(join(tmpdir(), 'coral-version-pairing-work-'));
  roots.push(projectRoot);
  const binDir = installTransferCodex(home);
  const work = { home, projectRoot, binDir, hosts: [] };
  const incumbent = spawnCoordinator({
    fixture: incumbentRoot,
    home,
    tempRoots: roots,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
  coordinators.push(incumbent);
  const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
  const state = join(home, '.fake-codex-state');
  const prompt = join(projectRoot, 'prompt.txt');
  writeFileSync(prompt, 'Keep working while a newer build arrives.');

  writeFileSync(join(state, 'complete-next'), 'warm-up');
  const warmUp = (await runFixtureCli(incumbentRoot.root, work, ['codex', '-i', prompt, '-d'])).match(
    /wait jobs ([0-9a-f-]{36})\b/u,
  )?.[1];
  if (warmUp === undefined) throw new Error('The warm-up job did not launch.');
  await waitForJobPhase(incumbentRoot.root, work, warmUp, 'completed');

  const jobId = (await runFixtureCli(incumbentRoot.root, work, ['codex', '-i', prompt, '-d'])).match(
    /wait jobs ([0-9a-f-]{36})\b/u,
  )?.[1];
  if (jobId === undefined) throw new Error('The hosted job did not launch.');
  await waitForCondition(() => existsSync(join(state, 'job-running')), 60_000);
  await waitForCondition(() => readHostProcesses(home) !== null, 30_000);
  const recorded = readHostProcesses(home);
  if (recorded === null) throw new Error('The hosted job runs in no provider host.');
  hostProcesses.push(...recorded);
  return { ...work, hosts: recorded, jobId, pid: initial.pid };
}

describe('AC18 Phase 6 version pairing', () => {
  let firstReleaseBuild = '';

  beforeAll(() => {
    assertBuildArtifactsAvailable();
    firstReleaseBuild = materializeFirstReleaseBuild(firstReleaseRoots);
  }, 300_000);

  afterAll(() => {
    for (const root of firstReleaseRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('upgrades an idle first-release incumbent to the host-transferring build', async () => {
    const home = newHome();
    const firstRelease = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.14',
      sourceBuildDir: firstReleaseBuild,
    });
    const incumbent = spawnCoordinator({ fixture: firstRelease, home, tempRoots: roots });
    coordinators.push(incumbent);
    const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);

    const phase6 = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15', accepts: 'bundled' });
    const contender = spawnCoordinator({ fixture: phase6, home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000), contender.output()).toEqual({ code: 0, signal: null });
    await waitForCondition(() => {
      const current = readDiscoveryRecordForHome(home, 'prod');
      const intent = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
      return (
        current !== null &&
        current.pid !== initial.pid &&
        current.bundleHash === phase6.bundleHash &&
        intent.kind === 'readable' &&
        intent.intent.disposition === 'completed'
      );
    }, 60_000);
    const successor = readDiscoveryRecordForHome(home, 'prod');
    if (successor === null) throw new Error('The first-release upgrade has no serving successor.');
    rememberSuccessor(successor.pid);
    expect(await probeCoordinatorSocket(successor.socketPath)).toBe('accepting');
    await waitForProcessExit(incumbent, 30_000);
  }, 120_000);

  it('keeps a first-release incumbent serving while its legacy host runs a job', async () => {
    const firstRelease = createPluginFixture(roots, {
      flavor: 'prod',
      version: '0.10.14',
      sourceBuildDir: firstReleaseBuild,
    });
    const work = await startHostedJob(firstRelease);

    const phase6 = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15', accepts: 'bundled' });
    const contender = spawnCoordinator({ fixture: phase6, home: work.home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000), contender.output()).toEqual({ code: 0, signal: null });
    const runDir = coordinatorFilesForHome(work.home, 'prod').runDir;
    await waitForCondition(() => {
      const intent = readUpgradeIntent(runDir);
      return (
        intent.kind === 'readable' &&
        intent.intent.blockers.some(
          (blocker) => blocker.owner === 'provider-proxy-sets' || blocker.owner === 'provider-operations',
        )
      );
    }, 60_000);
    expect(readDiscoveryRecordForHome(work.home, 'prod')?.pid).toBe(work.pid);
    expect(hostsAlive(work.hosts)).toBe(true);

    writeFileSync(join(work.home, '.fake-codex-state', 'release-job'), 'released');
    await waitForJobPhase(firstRelease.root, work, work.jobId, 'completed');
    expect(readDiscoveryRecordForHome(work.home, 'prod')?.pid).toBe(work.pid);
  }, 240_000);

  it('keeps a shipped incumbent serving while its legacy host runs a job', async () => {
    const shipped = createShippedPluginFixture(roots, 'v0.10.13');
    const work = await startHostedJob(shipped);

    const phase6 = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15', accepts: 'bundled' });
    const contender = spawnCoordinator({ fixture: phase6, home: work.home, tempRoots: roots });
    coordinators.push(contender);
    expect(await waitForProcessExit(contender, 30_000), contender.output()).toEqual({ code: 0, signal: null });
    expect(readDiscoveryRecordForHome(work.home, 'prod')?.pid).toBe(work.pid);
    expect(hostsAlive(work.hosts)).toBe(true);

    writeFileSync(join(work.home, '.fake-codex-state', 'release-job'), 'released');
    await waitForJobPhase(shipped.root, work, work.jobId, 'completed');
    expect(readDiscoveryRecordForHome(work.home, 'prod')?.pid).toBe(work.pid);
    expect(hostsAlive(work.hosts)).toBe(true);
  }, 240_000);
});
