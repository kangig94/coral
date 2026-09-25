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

import { afterEach, describe, expect, it } from 'vitest';

import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { v0109CoordinatorSocketGuardSetForRunDir } from '#src/infra/path/coordinator.js';
import { readUpgradeIntent, visibleUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { readActiveStoreSelectionForCoordination } from '#src/store/active-store-selection.js';
import { probeIncumbent } from '#src/transport/ipc/handoff.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  createShippedPluginFixture,
  probeCoordinatorSocket,
  readDiscoveryRecordForHome,
  SHIPPED_RELEASE_TAGS,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type ShippedReleaseTag,
  type ShippedPluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
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
const LEGACY_CLI_REPLACEMENT_TAGS = ['v0.10.0', 'v0.10.1', 'v0.10.2', 'v0.10.3', 'v0.10.4'] as const;

afterEach(async () => {
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
    env: { ...process.env, HOME: home, TMPDIR: home, CLAUDE_PLUGIN_ROOT: fixture.root },
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
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: home,
      CLAUDE_PLUGIN_ROOT: shipped.root,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
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
  const child = spawn(process.execPath, [cliPath, 'jobs', 'detail', jobId], {
    cwd: projectRoot,
    env: { ...process.env, HOME: home, TMPDIR: home, CLAUDE_PLUGIN_ROOT: dirname(dirname(cliPath)) },
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
  expect(code, output).toBe(0);
  return output;
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
      const intent = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
      expect(intent).toMatchObject({ kind: 'readable', intent: { target: { build: { version: '0.10.14' } } } });
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
    },
    55_000,
  );

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
        env: { ...process.env, HOME: home, TMPDIR: home, CLAUDE_PLUGIN_ROOT: shipped.root },
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
        if (shutdown.exitCode === null && shutdown.signalCode === null) shutdown.kill('SIGTERM');
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
        env: { CORAL_BACKEND_IDLE_MS: '100', PATH: `${binDir}:${process.env.PATH ?? ''}` },
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
      await waitForCondition(() => {
        const current = readDiscoveryRecordForHome(home, 'prod');
        return current !== null && current.pid !== initial.pid && current.bundleHash === branch.bundleHash;
      }, 60_000);
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
      const detail = await readJobDetail(join(branch.root, 'bridge', 'coral-cli'), home, projectRoot, completedJobId);
      expect(detail).toContain(`Job ${completedJobId}`);
      expect(detail).toContain('Phase: completed');
      expect(readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir)).toMatchObject({
        kind: 'readable',
        intent: { disposition: 'completed' },
      });
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
      try {
        const liveJobId = await launchShippedJob(shipped, home, projectRoot, binDir, 'running');
        incumbent.child.kill('SIGKILL');
        await waitForProcessExit(incumbent, 20_000);
        const branch = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
        let serving = readDiscoveryRecordForHome(home, 'prod');
        for (let attempt = 0; attempt < 3 && (serving === null || serving.pid === initial.pid); attempt++) {
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
          serving = readDiscoveryRecordForHome(home, 'prod');
          if (serving !== null && serving.pid !== initial.pid) break;
        }
        if (serving === null || serving.pid === initial.pid) {
          throw new Error('Direct crash upgrade did not reach a serving coordinator.');
        }
        rememberSuccessor(serving.pid);
        const completed = await readJobDetail(
          join(branch.root, 'bridge', 'coral-cli'),
          home,
          projectRoot,
          completedJobId,
        );
        expect(completed).toContain(`Job ${completedJobId}`);
        expect(completed).toContain('Phase: completed');
        const liveOrUnresolved = await readJobDetail(
          join(branch.root, 'bridge', 'coral-cli'),
          home,
          projectRoot,
          liveJobId,
        );
        expect(liveOrUnresolved).toContain(`Job ${liveJobId}`);
        expect(liveOrUnresolved).not.toMatch(/jobs?_not_found/u);
      } finally {
        writeFileSync(join(state, 'release-job'), 'released');
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
      const incumbent = spawnCoordinator({
        fixture: incumbentFixture,
        home,
        tempRoots: roots,
        // A delay past the successor's serving deadline self-fences the attempt; see SUCCESSION_PAUSE_ATTEMPT_MS.
        env: { CORAL_TEST_SUCCESSION_SERVING_DELAY_MS: '2000' },
      });
      coordinators.push(incumbent);
      const initial = await waitForDiscoveryRecord(home, 'prod', 20_000);
      const successorFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15' });
      const contender = spawnCoordinator({ fixture: successorFixture, home, tempRoots: roots });
      coordinators.push(contender);
      const [contenderExit] = await Promise.all([
        waitForProcessExit(contender, 30_000),
        waitForCondition(() => {
          const observed = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
          return observed.kind === 'readable' && visibleUpgradeIntent(observed.intent)?.phase === 'prepared';
        }, 30_000),
      ]);
      expect(contenderExit).toEqual({ code: 0, signal: null });
      const older = createShippedPluginFixture(roots, 'v0.10.13');
      const olderContender = spawnCoordinator({ fixture: older, home, tempRoots: roots });
      coordinators.push(olderContender);

      // The commit window closes at the successor's serving deadline, so the legacy arrivals must overlap it.
      await waitForCondition(() => {
        const observed = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
        return observed.kind === 'readable' && observed.intent.disposition === 'attempting';
      }, 30_000);
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
        expect(readUpgradeIntent(paths.runDir)).toMatchObject({
          kind: 'readable',
          intent: { disposition: 'completed' },
        });
      } finally {
        sampling = false;
        await addressSamples;
      }
      await waitForProcessExit(olderContender, 30_000);
      expect(readDiscoveryRecordForHome(home, 'prod')?.version).not.toBe(older.version);
    },
    100_000,
  );
});
