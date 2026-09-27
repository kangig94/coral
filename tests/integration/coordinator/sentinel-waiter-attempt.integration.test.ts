import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { upgradeIntentPath } from '#src/infra/path/index.js';

const root = mkdtempSync(join(tmpdir(), 'coral-red-sentinel-waiter-attempt-'));
const sentinelBundle = join(root, 'sentinel.cjs');
const childFixture = fileURLToPath(new URL('./fixtures/sentinel-waiter-attempt-child.mjs', import.meta.url));
const sentinels: ChildProcess[] = [];
const children: number[] = [];

beforeAll(async () => {
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/sentinel-harness.ts', import.meta.url))],
    outfile: sentinelBundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:*'],
  });
});

afterAll(async () => {
  for (const child of children) {
    try {
      process.kill(child, 'SIGKILL');
    } catch {
      continue;
    }
  }
  for (const sentinel of sentinels) if (sentinel.exitCode === null) sentinel.kill('SIGKILL');
  await waitForCondition(() => children.every((child) => !alive(child)), 5_000).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type Ready = Readonly<{
  kind: 'ready';
  pid: number;
  attemptId?: string;
  waiterLaunch?: string;
  spawnNonce?: string;
}>;

function isReady(message: unknown): message is Ready {
  return (
    typeof message === 'object' &&
    message !== null &&
    'kind' in message &&
    message.kind === 'ready' &&
    'pid' in message &&
    typeof message.pid === 'number'
  );
}

describe('sentinel recovery of a waiter target', () => {
  it('requires a current durable waiter claim before spawning', async () => {
    const runDir = mkdtempSync(join(root, 'spawn-claim-'));
    const seeded = await compareAndSwapUpgradeIntent(runDir, null, {
      requestId: 'waiter-request',
      incumbent: {
        instanceId: 'incumbent',
        pid: process.pid,
        incarnation: null,
        version: '0.10.13',
        bundleHash: 'old-hash',
        flavor: 'prod',
      },
      target: {
        pluginRootLabel: runDir,
        build: {
          version: '0.10.14',
          buildSetId: 'next-build',
          flavor: 'prod',
          storeFormatFingerprint: 'same-format',
          bundleHash: 'next-hash',
          cliBundleHash: 'next-cli',
          claudeAppserverBundleHash: 'next-appserver',
          durableWrapperBundleHash: 'next-wrapper',
        },
      },
      attemptId: 'claim-attempt',
      attemptSpawnNonce: 'claim-nonce',
      attemptSpawnPending: true,
      attemptChild: null,
      attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: process.pid, incarnation: null },
      disposition: 'attempting',
      blockers: [],
      retryCondition: null,
      attemptDeadline: new Date(Date.now() + 60_000).toISOString(),
      completionReceipt: null,
    });
    expect(seeded.kind).toBe('written');
    const launch = () => {
      const sentinel = spawn(process.execPath, [sentinelBundle, childFixture, 'no-fixture-relaunch'], {
        env: {
          ...process.env,
          CORAL_SENTINEL_RUN_DIR: runDir,
          CORAL_STARTUP_ATTEMPT_ID: 'claim-attempt',
          CORAL_WAITER_LAUNCHED: 'claim-attempt',
          CORAL_WAITER_SPAWN_NONCE: 'claim-nonce',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      sentinels.push(sentinel);
      return sentinel;
    };
    const accepted = launch();
    let childPid: number | null = null;
    accepted.on('message', (message: unknown) => {
      if (isReady(message)) {
        childPid = message.pid;
        children.push(message.pid);
      }
    });
    await waitForCondition(() => childPid !== null, 5_000);
    expect(readUpgradeIntent(runDir)).toMatchObject({ intent: { revision: 1 } });
    accepted.kill('SIGKILL');

    const current = readUpgradeIntent(runDir);
    if (current.kind !== 'readable') throw new Error('intent disappeared');
    const canceled = await compareAndSwapUpgradeIntent(runDir, current.intent.revision, {
      ...current.intent,
      attemptSpawnPending: false,
    });
    expect(canceled.kind).toBe('written');
    const refused = launch();
    let spawned = false;
    refused.on('message', (message: unknown) => {
      if (isReady(message)) spawned = true;
    });
    await waitForCondition(() => refused.exitCode !== null, 5_000);
    expect(refused.exitCode).toBe(1);
    expect(spawned).toBe(false);
  }, 15_000);

  it('does not spawn a child when the prepared record cannot be written', async () => {
    const blockedRunDir = join(root, 'blocked-run-dir');
    writeFileSync(blockedRunDir, 'not a directory');
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture], {
      env: { ...process.env, CORAL_SENTINEL_RUN_DIR: blockedRunDir },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    sentinels.push(sentinel);
    const childPids: number[] = [];
    sentinel.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-child' &&
        'pid' in message &&
        typeof message.pid === 'number'
      )
        childPids.push(message.pid);
    });
    await waitForCondition(() => sentinel.exitCode !== null, 5_000);
    expect(sentinel.exitCode).toBe(1);
    expect(childPids).toEqual([]);
  });

  it('keeps the waiter attempt credentials when it replaces a wedged target', async () => {
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture], {
      env: {
        ...process.env,
        CORAL_SENTINEL_RUN_DIR: root,
        CORAL_STARTUP_ATTEMPT_ID: 'waiter-attempt',
        CORAL_WAITER_LAUNCHED: 'waiter-attempt',
        CORAL_WAITER_SPAWN_NONCE: 'waiter-spawn-nonce',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    sentinels.push(sentinel);
    const ready: Ready[] = [];
    sentinel.on('message', (message: unknown) => {
      if (!isReady(message)) return;
      ready.push(message);
      children.push(message.pid);
    });

    await waitForCondition(() => ready.length === 1, 5_000);
    const firstPid = ready[0]?.pid;
    if (firstPid === undefined) throw new Error('Missing first coordinator');
    const firstIncarnation = probeProcessIncarnation(firstPid);
    if (firstIncarnation === null) throw new Error('Missing first coordinator incarnation');
    writeFileSync(
      upgradeIntentPath(root),
      JSON.stringify({
        version: 'v1',
        requestId: 'waiter-request',
        revision: 1,
        incumbent: {
          instanceId: 'incumbent',
          pid: process.pid,
          incarnation: null,
          version: '0.10.13',
          bundleHash: 'old-hash',
          flavor: 'prod',
        },
        target: {
          pluginRootLabel: root,
          build: {
            version: '0.10.14',
            buildSetId: 'next-build',
            flavor: 'prod',
            storeFormatFingerprint: 'same-format',
            bundleHash: 'next-hash',
            cliBundleHash: 'next-cli',
            claudeAppserverBundleHash: 'next-appserver',
            durableWrapperBundleHash: 'next-wrapper',
          },
        },
        attemptId: 'waiter-attempt',
        attemptSpawnNonce: 'waiter-spawn-nonce',
        attemptChild: { attemptId: 'waiter-attempt', pid: firstPid, incarnation: firstIncarnation },
        attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: process.pid, incarnation: null },
        disposition: 'attempting',
        blockers: [],
        retryCondition: null,
        attemptDeadline: new Date(Date.now() + 60_000).toISOString(),
        completionReceipt: null,
      }),
    );
    sentinel.send({ kind: 'freeze' });
    await waitForCondition(
      () => readdirSync(root).filter((entry) => entry.startsWith('waiter-child-')).length === 2,
      8_000,
    );

    const replacement = readdirSync(root)
      .filter((entry) => entry.startsWith('waiter-child-'))
      .map((entry) => JSON.parse(readFileSync(join(root, entry), 'utf8')) as Ready)
      .find((entry) => entry.pid !== ready[0]?.pid);
    if (replacement === undefined) throw new Error('Sentinel did not record a replacement coordinator');
    children.push(replacement.pid);

    expect(replacement).toMatchObject({
      attemptId: 'waiter-attempt',
      waiterLaunch: 'waiter-attempt',
      spawnNonce: 'waiter-spawn-nonce',
    });
    const rebound = readUpgradeIntent(root);
    expect(rebound.kind).toBe('readable');
    if (rebound.kind === 'readable') {
      expect(rebound.intent.attemptChild).toMatchObject({
        attemptId: 'waiter-attempt',
        pid: replacement.pid,
        incarnation: probeProcessIncarnation(replacement.pid),
      });
    }
  }, 15_000);

  it('replaces a wedged completed waiter target as an ordinary coordinator', async () => {
    const runDir = mkdtempSync(join(root, 'completed-'));
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture], {
      env: {
        ...process.env,
        CORAL_SENTINEL_RUN_DIR: runDir,
        CORAL_STARTUP_ATTEMPT_ID: 'completed-attempt',
        CORAL_WAITER_LAUNCHED: 'completed-attempt',
        CORAL_WAITER_SPAWN_NONCE: 'completed-nonce',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    sentinels.push(sentinel);
    let firstPid: number | null = null;
    sentinel.on('message', (message: unknown) => {
      if (isReady(message)) {
        firstPid = message.pid;
        children.push(message.pid);
      }
    });
    await waitForCondition(() => firstPid !== null, 5_000);
    if (firstPid === null) throw new Error('Missing first coordinator');
    const incarnation = probeProcessIncarnation(firstPid);
    if (incarnation === null) throw new Error('Missing first coordinator incarnation');
    const build = {
      version: '0.10.14',
      buildSetId: 'next-build',
      flavor: 'prod',
      storeFormatFingerprint: 'same-format',
      bundleHash: 'next-hash',
      cliBundleHash: 'next-cli',
      claudeAppserverBundleHash: 'next-appserver',
      durableWrapperBundleHash: 'next-wrapper',
    };
    writeFileSync(
      upgradeIntentPath(runDir),
      JSON.stringify({
        version: 'v1',
        requestId: 'waiter-request',
        revision: 1,
        incumbent: {
          instanceId: 'incumbent',
          pid: process.pid,
          incarnation: null,
          version: '0.10.13',
          bundleHash: 'old-hash',
          flavor: 'prod',
        },
        target: { pluginRootLabel: runDir, build },
        attemptId: 'completed-attempt',
        attemptSpawnNonce: 'completed-nonce',
        attemptChild: { attemptId: 'completed-attempt', pid: firstPid, incarnation },
        attemptOwner: { kind: 'waiter', instanceId: 'waiter', pid: process.pid, incarnation: null },
        disposition: 'completed',
        blockers: [],
        retryCondition: null,
        attemptDeadline: new Date(Date.now() - 1_000).toISOString(),
        completionReceipt: {
          kind: 'serving',
          attemptId: 'completed-attempt',
          successor: { instanceId: 'successor', pid: firstPid, incarnation, build },
          epochKey: 'lineage:epoch-1',
          controlGeneration: 1,
          acceptedObligations: [],
          recordedAt: new Date(Date.now() - 2_000).toISOString(),
        },
      }),
    );
    expect(readUpgradeIntent(runDir).kind).toBe('readable');
    sentinel.send({ kind: 'freeze' });
    await waitForCondition(
      () => readdirSync(runDir).filter((entry) => entry.startsWith('waiter-child-')).length === 2,
      8_000,
    ).catch((error: unknown) => {
      const records = readdirSync(join(runDir, 'coordinator-sentinel.v1')).map((name) =>
        readFileSync(join(runDir, 'coordinator-sentinel.v1', name), 'utf8'),
      );
      throw new Error(`${String(error)}; records=${records.join(' | ')}`);
    });
    const replacement = readdirSync(runDir)
      .filter((entry) => entry.startsWith('waiter-child-'))
      .map((entry) => JSON.parse(readFileSync(join(runDir, entry), 'utf8')) as Ready)
      .find((entry) => entry.pid !== firstPid);
    if (replacement === undefined) throw new Error('Missing replacement coordinator');
    children.push(replacement.pid);
    expect(replacement.attemptId).toBeUndefined();
    expect(replacement.waiterLaunch).toBeUndefined();
    expect(replacement.spawnNonce).toBeUndefined();
  }, 15_000);

  it('does not relaunch a waiter target whose durable attempt is stale', async () => {
    const staleRunDir = mkdtempSync(join(root, 'stale-'));
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture], {
      env: {
        ...process.env,
        CORAL_SENTINEL_RUN_DIR: staleRunDir,
        CORAL_STARTUP_ATTEMPT_ID: 'stale-attempt',
        CORAL_WAITER_LAUNCHED: 'stale-attempt',
        CORAL_WAITER_SPAWN_NONCE: 'stale-nonce',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    sentinels.push(sentinel);
    await new Promise<void>((resolve) => {
      sentinel.on('message', (message: unknown) => {
        if (isReady(message)) {
          children.push(message.pid);
          resolve();
        }
      });
    });
    sentinel.send({ kind: 'freeze' });
    await waitForCondition(() => sentinel.exitCode !== null, 8_000);
    expect(readdirSync(staleRunDir).filter((entry) => entry.startsWith('waiter-child-'))).toHaveLength(1);
    const recordFiles = readdirSync(join(staleRunDir, 'coordinator-sentinel.v1'));
    expect(
      recordFiles.map((name) => JSON.parse(readFileSync(join(staleRunDir, 'coordinator-sentinel.v1', name), 'utf8'))),
    ).toContainEqual(
      expect.objectContaining({ state: 'relaunch-unavailable', reason: 'waiter attempt is no longer current' }),
    );
  }, 15_000);
});
