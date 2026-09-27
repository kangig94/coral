import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForCondition } from '#tests/support/wait-for-condition.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { readUpgradeIntent } from '#src/infra/upgrade-intent.js';
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
