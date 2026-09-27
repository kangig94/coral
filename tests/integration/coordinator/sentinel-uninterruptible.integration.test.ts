import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'coral-sentinel-d-state-'));
const sentinelBundle = join(root, 'sentinel.cjs');
const childFixture = fileURLToPath(new URL('./fixtures/sentinel-child.mjs', import.meta.url));

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

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('coordinator sentinel with an uninterruptible child', () => {
  it('eventually terminates a child that stays in uninterruptible sleep after heartbeats lapse', async () => {
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture, 'd-state'], {
      env: { ...process.env, CORAL_SENTINEL_RUN_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let childPid: number | null = null;
    sentinel.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'ready' &&
        'pid' in message &&
        typeof message.pid === 'number'
      ) {
        childPid = message.pid;
        sentinel.send({ kind: 'freeze' });
      }
    });
    try {
      const exited = new Promise<void>((resolve) => sentinel.once('exit', () => resolve()));
      await expect(
        Promise.race([
          exited.then(() => 'terminated'),
          new Promise((resolve) => setTimeout(() => resolve('timed-out'), 4_000)),
        ]),
      ).resolves.toBe('terminated');
      expect(childPid).not.toBeNull();
      expect(() => process.kill(childPid as number, 0)).toThrow();
    } finally {
      if (sentinel.exitCode === null) sentinel.kill('SIGKILL');
      if (childPid !== null) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          /* already reaped */
        }
      }
    }
  }, 6_000);

  it('kills an unarmed child when the durable armed write fails', async () => {
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture, 'arm-write-fails'], {
      env: { ...process.env, CORAL_SENTINEL_RUN_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let announcedChild = false;
    sentinel.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-child'
      )
        announcedChild = true;
    });
    try {
      const exited = new Promise<number | null>((resolve) => sentinel.once('exit', resolve));
      await expect(
        Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timed-out'), 1_500))]),
      ).resolves.toBe(1);
      expect(announcedChild).toBe(false);
    } finally {
      if (sentinel.exitCode === null) sentinel.kill('SIGKILL');
    }
  }, 3_000);
});
