import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { observeSuccessionWriterGeneration } from '#src/store/succession-writer-generation.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  waitForProcessExit,
  storeDbPathForHome,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const successorPids: { pid: number; incarnation: ProcessIncarnation | null }[] = [];
const commitFailures: [string, Record<string, string>][] = [
  ['open failure', { CORAL_TEST_SUCCESSION_OPEN_FAILURE: '1' }],
  ['successor crash before serving', { CORAL_TEST_SUCCESSION_CRASH_BEFORE_SERVING: '1' }],
];

afterEach(async () => {
  for (const successor of successorPids.splice(0)) {
    if (
      successor.incarnation !== null &&
      probeProcessIncarnation(successor.pid) === successor.incarnation &&
      observeProcessLiveness(successor.pid) === 'alive'
    ) process.kill(successor.pid, 'SIGTERM');
  }
  for (const coordinator of coordinators.splice(0)) await stopCoordinator(coordinator);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

async function assertAddressClaimed(socketPath: string): Promise<void> {
  const contender = createServer();
  await new Promise<void>((resolve, reject) => {
    contender.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve();
      else reject(error);
    });
    contender.listen(socketPath, () => {
      contender.close();
      reject(new Error('The canonical coordinator address was released.'));
    });
  });
}

describe('real-process succession commit', () => {
  it.each([false, true])('hands an empty same-format epoch to the incumbent-launched successor with dropped serving ack=%s', async (dropServingAck) => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-succession-commit-'));
    roots.push(home);
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env: dropServingAck ? { CORAL_TEST_SUCCESSION_DROP_SERVING_ACK: '1' } : {},
    });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    let sampleAddress = true;
    const addressSamples = (async () => {
      while (sampleAddress) {
        await assertAddressClaimed(initial.socketPath);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })();
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);

    try {
      await waitForProcessExit(contender, 30_000);
      await waitForCondition(() => readDiscoveryRecordForHome(home, 'prod')?.pid !== initial.pid, 60_000);
    } finally {
      sampleAddress = false;
      await addressSamples;
    }
    const successor = readDiscoveryRecordForHome(home, 'prod');
    if (successor === null) throw new Error('Successor discovery was not published.');
    successorPids.push({ pid: successor.pid, incarnation: probeProcessIncarnation(successor.pid) });
    expect(successor.bundleHash).toBe(newerFixture.bundleHash);
    expect(successor.pid).not.toBe(initial.pid);
    expect(observeProcessLiveness(successor.pid)).toBe('alive');
    await waitForProcessExit(old, 30_000);
    await assertAddressClaimed(successor.socketPath);
  });

  it.each(commitFailures)('records a %s hold, reclaims the advanced generation, and retains the incumbent epoch', async (_failure, env) => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-succession-open-hold-'));
    roots.push(home);
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env,
    });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    await waitForProcessExit(contender, 30_000);

    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const observed = readUpgradeIntent(runDir);
      return observed.kind === 'readable' &&
        observed.intent.disposition === 'deferred' &&
        observed.intent.blockers.some((blocker) => blocker.reason.includes('incumbent reclaimed'));
    }, 60_000);
    expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);
    expect(observeProcessLiveness(initial.pid)).toBe('alive');
    expect(existsSync(storeDbPathForHome(home, 'prod', '2'))).toBe(false);
    await assertAddressClaimed(initial.socketPath);
  });

  it('serves through a same-build recovery child when in-place writer reclaim fails', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-succession-recovery-child-'));
    roots.push(home);
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env: {
        CORAL_TEST_SUCCESSION_OPEN_FAILURE: '1',
        CORAL_TEST_SUCCESSION_RECLAIM_FAILURE: '1',
      },
    });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    await waitForProcessExit(contender, 30_000);

    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery !== null && discovery.pid !== initial.pid && discovery.bundleHash === oldFixture.bundleHash;
    }, 60_000);
    const recovered = readDiscoveryRecordForHome(home, 'prod');
    if (recovered === null) throw new Error('Same-build recovery discovery was not published.');
    successorPids.push({ pid: recovered.pid, incarnation: probeProcessIncarnation(recovered.pid) });
    await waitForProcessExit(old, 30_000);
    expect(observeProcessLiveness(initial.pid)).toBe('absent');
    expect(observeProcessLiveness(recovered.pid)).toBe('alive');
    expect(existsSync(storeDbPathForHome(home, 'prod', '2'))).toBe(false);
    const observed = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
    expect(observed).toMatchObject({
      kind: 'readable',
      intent: {
        disposition: 'deferred',
        retryCondition: { kind: 'target-change' },
      },
    });
    await assertAddressClaimed(initial.socketPath);
  });

  it('recovers a crashed committed successor on its own build and exact epoch', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-committed-successor-recovery-'));
    roots.push(home);
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const old = spawnCoordinator({ fixture: oldFixture, home, tempRoots: roots });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    await waitForProcessExit(contender, 30_000);
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery !== null && discovery.pid !== initial.pid;
    }, 60_000);
    await waitForProcessExit(old, 30_000);
    const committed = readDiscoveryRecordForHome(home, 'prod');
    if (committed === null) throw new Error('Committed successor discovery was not published.');
    const first = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
    if (first.kind !== 'readable' || first.intent.completionReceipt === null) {
      throw new Error('Committed successor has no durable serving receipt.');
    }
    const epochKey = first.intent.completionReceipt.epochKey;
    const committedIncarnation = probeProcessIncarnation(committed.pid);
    if (committedIncarnation === null) throw new Error('Committed successor incarnation is unavailable.');
    process.kill(committed.pid, 'SIGKILL');
    await waitForCondition(() => observeProcessLiveness(committed.pid) === 'absent', 15_000);

    const recovery = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(recovery);
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery !== null && discovery.pid !== committed.pid && discovery.bundleHash === newerFixture.bundleHash;
    }, 60_000);
    const recovered = readDiscoveryRecordForHome(home, 'prod');
    if (recovered === null) throw new Error('Committed recovery discovery was not published.');
    expect(recovered.pid).not.toBe(initial.pid);
    expect(observeProcessLiveness(initial.pid)).toBe('absent');
    expect(observeProcessLiveness(recovered.pid)).toBe('alive');
    expect(existsSync(storeDbPathForHome(home, 'prod', '2'))).toBe(false);
    const final = readUpgradeIntent(coordinatorFilesForHome(home, 'prod').runDir);
    expect(final.kind === 'readable' ? final.intent.completionReceipt?.epochKey : null).toBe(epochKey);
    await assertAddressClaimed(recovered.socketPath);
  });

  it('reclaims in place when the same-build recovery child dies after generation advance', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-recovery-child-crash-'));
    roots.push(home);
    const projectRoot = mkdtempSync(join(tmpdir(), 'coral-recovery-child-work-'));
    roots.push(projectRoot);
    const binDir = join(home, 'bin');
    mkdirSync(binDir);
    mkdirSync(join(home, '.fake-codex-state'));
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
    );
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'gated-codex-appserver.cjs'), join(binDir, 'codex'));
    chmodSync(join(binDir, 'codex'), 0o755);
    writeFileSync(join(home, '.fake-codex-state', 'release-job'), 'released');
    const prompt = join(projectRoot, 'prompt.txt');
    writeFileSync(prompt, 'Work accepted after the incumbent reclaims its writer.');
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env: {
        CORAL_TEST_SUCCESSION_OPEN_FAILURE: '1',
        CORAL_TEST_SUCCESSION_RECLAIM_FAILURE: '1',
        CORAL_TEST_SUCCESSION_SERVING_DELAY_MS: '3000',
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    await waitForProcessExit(contender, 30_000);

    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    await waitForCondition(() => {
      const observed = readUpgradeIntent(runDir);
      const writer = observeSuccessionWriterGeneration(runtime);
      return observed.kind === 'readable' &&
        typeof observed.intent.recoveryAttemptId === 'string' &&
        observed.intent.attemptChild !== null &&
        observed.intent.attemptChild !== undefined &&
        writer !== null && writer.generation >= 4;
    }, 60_000);
    const recovering = readUpgradeIntent(runDir);
    if (recovering.kind !== 'readable' || recovering.intent.attemptChild == null) {
      throw new Error('Recovery child identity was not recorded.');
    }
    process.kill(recovering.intent.attemptChild.pid, 'SIGKILL');
    await waitForCondition(() => {
      const observed = readUpgradeIntent(runDir);
      return observed.kind === 'readable' && observed.intent.attemptId === null &&
        observed.intent.blockers.some((blocker) => blocker.reason.includes('incumbent reclaimed'));
    }, 60_000);
    expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);
    expect(observeProcessLiveness(initial.pid)).toBe('alive');
    expect(observeSuccessionWriterGeneration(runtime)?.generation).toBeGreaterThan(4);
    await assertAddressClaimed(initial.socketPath);

    const cli = spawn('node', [join(oldFixture.root, 'bridge', 'coral-cli'), 'codex', '-i', prompt], {
      cwd: projectRoot,
      env: { ...process.env, HOME: home, TMPDIR: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    cli.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    cli.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    const status = await new Promise<number>((resolve, reject) => {
      const deadline = setTimeout(() => {
        cli.kill('SIGKILL');
        reject(new Error(`Post-reclaim launch timed out: ${output}`));
      }, 30_000);
      cli.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      cli.once('close', (code) => {
        clearTimeout(deadline);
        resolve(code ?? -1);
      });
    });
    expect(status, output).toBe(0);
    const jobId = output.match(/Provider job (\S+) launch accepted/u)?.[1];
    if (jobId === undefined) throw new Error(`Post-reclaim launch had no job id: ${output}`);
    const result = join(home, '.coral', 'exports', 'jobs', jobId, 'result.md');
    await waitForCondition(() => existsSync(result), 30_000);
    expect(readFileSync(result, 'utf8')).toContain('done');
  });

  it('aborts and reclaims an uncommitted attempt before honoring incumbent SIGTERM', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-succession-sigterm-before-'));
    roots.push(home);
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env: { CORAL_TEST_SUCCESSION_SERVING_DELAY_MS: '1500' },
    });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    await waitForProcessExit(contender, 30_000);
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const observed = readUpgradeIntent(runDir);
      return observed.kind === 'readable' && observed.intent.disposition === 'attempting';
    }, 30_000);
    const attempting = readUpgradeIntent(runDir);
    expect(attempting.kind === 'readable' ? attempting.intent.attemptChild?.pid : null).toBeGreaterThan(0);
    old.child.kill('SIGTERM');
    await waitForProcessExit(old, 30_000);
    const observed = readUpgradeIntent(runDir);
    expect(observed.kind === 'readable' && observed.intent.disposition === 'completed').toBe(false);
    expect(existsSync(storeDbPathForHome(home, 'prod', '2'))).toBe(false);
    expect(readDiscoveryRecordForHome(home, 'prod')?.pid).not.toBe(initial.pid);
  });

  it('treats SIGTERM after durable serving as incumbent release', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-succession-sigterm-after-'));
    roots.push(home);
    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.0.1' });
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env: { CORAL_TEST_SUCCESSION_RELEASE_DELAY_MS: '1500' },
    });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const newerFixture = createPluginFixture(roots, { flavor: 'prod' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    await waitForProcessExit(contender, 30_000);
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const observed = readUpgradeIntent(runDir);
      return observed.kind === 'readable' && observed.intent.disposition === 'completed';
    }, 60_000);
    if (old.child.exitCode === null && old.child.signalCode === null) old.child.kill('SIGTERM');
    await waitForProcessExit(old, 30_000);
    const successor = readDiscoveryRecordForHome(home, 'prod');
    if (successor === null) throw new Error('Committed successor discovery is absent.');
    successorPids.push({ pid: successor.pid, incarnation: probeProcessIncarnation(successor.pid) });
    expect(successor.pid).not.toBe(initial.pid);
    expect(observeProcessLiveness(successor.pid)).toBe('alive');
    await assertAddressClaimed(successor.socketPath);
  });
});
