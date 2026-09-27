import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForCondition } from '#tests/support/wait-for-condition.js';

const root = mkdtempSync(join(tmpdir(), 'coral-sentinel-test-'));
const sentinelBundle = join(root, 'sentinel.cjs');
const childFixture = fileURLToPath(new URL('./fixtures/sentinel-child.mjs', import.meta.url));
const sentinels: ChildProcess[] = [];

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
  rmSync(root, { recursive: true, force: true });
});

function launch(): Readonly<{
  sentinel: ChildProcess;
  childPid: Promise<number>;
  ready: Promise<void>;
  exited: Promise<void>;
}> {
  const sentinel = spawn(process.execPath, [sentinelBundle, childFixture], {
    env: { ...process.env, CORAL_SENTINEL_RUN_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  sentinels.push(sentinel);
  const childPid = new Promise<number>((resolve) => {
    sentinel.on('message', (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'kind' in message &&
        message.kind === 'coral-sentinel-child' &&
        'pid' in message &&
        typeof message.pid === 'number'
      ) {
        resolve(message.pid);
      }
    });
  });
  const ready = new Promise<void>((resolve) => {
    sentinel.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'ready') resolve();
    });
  });
  const exited = new Promise<void>((resolve) => sentinel.once('exit', () => resolve()));
  return { sentinel, childPid, ready, exited };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('coordinator sentinel process', () => {
  it('terminates exactly its blocked child and allows a replacement to serve', async () => {
    const first = launch();
    const pid = await first.childPid;
    await first.ready;
    first.sentinel.send({ kind: 'freeze' });
    await first.exited;
    expect(first.sentinel.exitCode).toBe(137);
    expect(alive(pid)).toBe(false);

    const replacement = launch();
    const replacementPid = await replacement.childPid;
    await replacement.ready;
    expect(replacementPid).not.toBe(pid);
    expect(alive(replacementPid)).toBe(true);
    replacement.sentinel.send({ kind: 'exit' });
    await replacement.exited;
    expect(replacement.sentinel.exitCode).toBe(0);
    expect(alive(replacementPid)).toBe(false);
  }, 15_000);

  it('grants a fresh window after the sentinel itself was frozen', async () => {
    const launched = launch();
    const pid = await launched.childPid;
    await launched.ready;
    launched.sentinel.send({ kind: 'freeze' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    launched.sentinel.kill('SIGSTOP');
    await new Promise((resolve) => setTimeout(resolve, 500));
    launched.sentinel.kill('SIGCONT');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(pid)).toBe(true);
    await launched.exited;
    expect(alive(pid)).toBe(false);
  }, 15_000);

  it('keeps escalation after the child answers following SIGTERM', async () => {
    const launched = launch();
    const pid = await launched.childPid;
    await launched.ready;
    launched.sentinel.send({ kind: 'pause-answers' });
    await launched.exited;
    expect(alive(pid)).toBe(false);
    expect(launched.sentinel.exitCode).toBe(137);
  }, 10_000);

  it('ends its coordinator after parent-pipe EOF', async () => {
    const launched = launch();
    const pid = await launched.childPid;
    await launched.ready;
    launched.sentinel.kill('SIGKILL');
    await launched.exited;
    await waitForCondition(() => !alive(pid), 5_000);
  }, 10_000);

  it('still ends an unresponsive child after the private channel closes', async () => {
    const launched = launch();
    const pid = await launched.childPid;
    await launched.ready;
    launched.sentinel.send({ kind: 'disconnect-and-freeze' });
    await launched.exited;
    expect(alive(pid)).toBe(false);
  }, 10_000);
});
