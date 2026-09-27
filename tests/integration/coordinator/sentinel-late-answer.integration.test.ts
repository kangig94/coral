import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForCondition } from '#tests/support/wait-for-condition.js';

const root = mkdtempSync(join(tmpdir(), 'coral-red-sentinel-'));
const sentinelBundle = join(root, 'sentinel.cjs');
const childFixture = fileURLToPath(new URL('./fixtures/late-answer-exits-child.mjs', import.meta.url));
const sentinels: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function records(): readonly Record<string, unknown>[] {
  const directory = join(root, 'coordinator-sentinel.v1');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).map(
    (name) => JSON.parse(readFileSync(join(directory, name), 'utf8')) as Record<string, unknown>,
  );
}

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

afterAll(() => {
  for (const sentinel of sentinels) if (sentinel.exitCode === null) sentinel.kill('SIGKILL');
  for (const record of records()) {
    if (typeof record.coordinatorPid === 'number' && alive(record.coordinatorPid))
      process.kill(record.coordinatorPid, 'SIGKILL');
  }
  rmSync(root, { recursive: true, force: true });
});

describe('coordinator sentinel recovery', () => {
  it('relaunches after a late heartbeat cannot prevent the coordinator from honoring SIGTERM', async () => {
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture], {
      env: { ...process.env, CORAL_SENTINEL_RUN_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    sentinels.push(sentinel);
    await new Promise<void>((resolve) => {
      sentinel.on('message', (message: unknown) => {
        if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'ready') resolve();
      });
    });

    sentinel.send({ kind: 'pause-answers' });
    await new Promise<void>((resolve) => sentinel.once('exit', () => resolve()));

    await waitForCondition(() => records().some((record) => record.state === 'relaunched'), 5_000);
    const replacement = records().find((record) => record.state === 'armed' && record.sentinelPid !== sentinel.pid);
    expect(replacement).toMatchObject({ state: 'armed' });
    expect(typeof replacement?.coordinatorPid).toBe('number');
    expect(alive(replacement?.coordinatorPid as number)).toBe(true);
  }, 15_000);

  it('records a terminal status when no valid replacement root exists', async () => {
    const sentinel = spawn(process.execPath, [sentinelBundle, childFixture, 'no-fixture-relaunch'], {
      env: { ...process.env, HOME: root, CORAL_SENTINEL_RUN_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    sentinels.push(sentinel);
    await new Promise<void>((resolve) => {
      sentinel.on('message', (message: unknown) => {
        if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'ready') resolve();
      });
    });
    sentinel.send({ kind: 'pause-answers' });
    await new Promise<void>((resolve) => sentinel.once('exit', () => resolve()));
    expect(records().some((record) => record.state === 'relaunch-unavailable')).toBe(true);
  }, 15_000);
});
