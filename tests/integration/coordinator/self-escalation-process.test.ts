import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { observeProcessLiveness, probeProcessIncarnation, type ProcessIncarnation } from '#src/infra/node-process.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import {
  assertBuildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  createShippedPluginFixture,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type PluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const roots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const successors: { pid: number; incarnation: ProcessIncarnation | null }[] = [];

afterEach(async () => {
  for (const successor of successors.splice(0)) {
    if (
      successor.incarnation !== null &&
      probeProcessIncarnation(successor.pid) === successor.incarnation &&
      observeProcessLiveness(successor.pid) === 'alive'
    ) {
      process.kill(successor.pid, 'SIGTERM');
    }
  }
  for (const coordinator of coordinators.splice(0)) await stopCoordinator(coordinator);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

async function runCli(
  fixture: PluginFixture,
  home: string,
  projectRoot: string,
  binDir: string,
  args: string[],
): Promise<string> {
  const child = spawn('node', [join(fixture.root, 'bridge', 'coral-cli'), ...args], {
    cwd: projectRoot,
    env: { ...process.env, HOME: home, TMPDIR: home, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  const status = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      resolve(code ?? -1);
    });
  });
  expect(status, output).toBe(0);
  return output;
}

describe('real-process incumbent self-escalation', () => {
  it('waits for session B app-server work to finish, then succeeds without another trigger', async () => {
    assertBuildArtifactsAvailable();
    const home = mkdtempSync(join(tmpdir(), 'coral-self-escalation-home-'));
    roots.push(home);
    const sessionA = mkdtempSync(join(tmpdir(), 'coral-self-escalation-a-'));
    const sessionB = mkdtempSync(join(tmpdir(), 'coral-self-escalation-b-'));
    roots.push(sessionA, sessionB);
    const binDir = join(home, 'bin');
    const state = join(home, '.fake-codex-state');
    mkdirSync(binDir);
    mkdirSync(state);
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
    );
    copyFileSync(join(process.cwd(), 'tests', 'fixtures', 'gated-codex-appserver.cjs'), join(binDir, 'codex'));
    chmodSync(join(binDir, 'codex'), 0o755);
    const prompt = join(sessionB, 'prompt.txt');
    writeFileSync(prompt, 'Keep session B running until its gate opens.');

    const oldFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.14' });
    const old = spawnCoordinator({
      fixture: oldFixture,
      home,
      tempRoots: roots,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        CORAL_BROKER_IDLE_MS: '100',
      },
    });
    coordinators.push(old);
    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    await runCli(oldFixture, home, sessionA, binDir, ['backend', 'status']);
    const launch = await runCli(oldFixture, home, sessionB, binDir, ['codex', '-i', prompt, '-d']);
    const jobId = launch.match(/wait jobs (\S+)/u)?.[1];
    if (jobId === undefined) throw new Error(`Session B did not launch an app-server job: ${launch}`);
    await waitForCondition(() => existsSync(join(state, 'job-running')), 30_000);

    for (const tag of ['v0.10.0', 'v0.10.13'] as const) {
      const shipped = createShippedPluginFixture(roots, tag);
      const olderContender = spawnCoordinator({ fixture: shipped, home, tempRoots: roots });
      coordinators.push(olderContender);
      // A shipped v0.10.0 contender polls a refusing incumbent for its whole 30s handoff drain budget before exiting.
      await waitForProcessExit(olderContender, 45_000);
      expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);
      expect(existsSync(join(state, 'job-running'))).toBe(true);
    }

    const newerFixture = createPluginFixture(roots, { flavor: 'prod', version: '0.10.15' });
    const contender = spawnCoordinator({ fixture: newerFixture, home, tempRoots: roots });
    coordinators.push(contender);
    await waitForProcessExit(contender, 30_000);
    expect(readDiscoveryRecordForHome(home, 'prod')?.pid).toBe(initial.pid);
    expect(observeProcessLiveness(initial.pid)).toBe('alive');
    const runDir = coordinatorFilesForHome(home, 'prod').runDir;
    await waitForCondition(() => {
      const observed = readUpgradeIntent(runDir);
      return (
        observed.kind === 'readable' &&
        observed.intent.disposition === 'deferred' &&
        observed.intent.blockers.length > 0
      );
    }, 30_000);

    writeFileSync(join(state, 'release-job'), 'released');
    const result = join(home, '.coral', 'exports', 'jobs', jobId, 'result.md');
    await waitForCondition(() => existsSync(result), 30_000);
    expect(readFileSync(result, 'utf8')).toContain('done');
    await waitForCondition(() => {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      return discovery !== null && discovery.pid !== initial.pid && discovery.bundleHash === newerFixture.bundleHash;
    }, 60_000);
    const serving = readDiscoveryRecordForHome(home, 'prod');
    if (serving === null) throw new Error('Self-escalated successor did not publish discovery.');
    successors.push({ pid: serving.pid, incarnation: probeProcessIncarnation(serving.pid) });
    await waitForProcessExit(old, 30_000);
    expect(observeProcessLiveness(serving.pid)).toBe('alive');
    expect(readUpgradeIntent(runDir)).toMatchObject({ kind: 'readable', intent: { disposition: 'completed' } });
  }, 150_000);
});
