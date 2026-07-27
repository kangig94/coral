import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type * as NodePath from 'node:path';

import { SIGTERM_GRACE_MS } from '#src/infra/process-constants.js';

const tempRoots: string[] = [];

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal: NodeJS.Signals) => boolean;
};

function createFakeChild(onKill?: (signal: NodeJS.Signals) => void): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    onKill?.(signal);
    return true;
  });
  return child;
}

function writeScript(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-multi-process-driver-'));
  const scriptPath = join(root, 'worker.cjs');
  tempRoots.push(root);
  writeFileSync(scriptPath, body, 'utf-8');
  return scriptPath;
}

function currentPathKey(): string {
  const keys = Object.keys(process.env).filter((key) => key.toUpperCase() === 'PATH');
  if (keys.includes('PATH')) {
    return 'PATH';
  }
  return keys.at(-1) ?? 'PATH';
}

afterEach(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }

  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('node:child_process');
  vi.unmock('node:path');
});

describe('spawnNodeScript', () => {
  it('parses stdout with the caller generic and leaves parsed undefined without a parser', async () => {
    const { spawnNodeScript } = await import('#tests/helpers/multi-process-driver.js');

    const parsedScript = writeScript('process.stdout.write(JSON.stringify({ value: process.argv[2] }));');
    const parsedPromise = spawnNodeScript<{ value: string }>({
      scriptPath: parsedScript,
      args: ['ok'],
      env: { ...process.env },
      timeoutMs: 1_000,
      parseStdout: (stdout) => JSON.parse(stdout) as { value: string },
    });
    expectTypeOf<Awaited<typeof parsedPromise>['parsed']>().toEqualTypeOf<{ value: string } | undefined>();

    const parsedResult = await parsedPromise;
    expect(parsedResult.parsed).toEqual({ value: 'ok' });
    expect(parsedResult.stdout).toBe('{"value":"ok"}');

    const rawScript = writeScript("process.stdout.write('raw-output');");
    const rawPromise = spawnNodeScript({
      scriptPath: rawScript,
      args: [],
      env: { ...process.env },
      timeoutMs: 1_000,
    });

    const rawResult = await rawPromise;
    const parsedIsUndefined: undefined = rawResult.parsed;
    expect(parsedIsUndefined).toBeUndefined();
    expect(rawResult.parsed).toBeUndefined();
    expect(rawResult.stdout).toBe('raw-output');
  });

  it('sends SIGTERM before SIGKILL after the grace window on timeout', async () => {
    vi.useFakeTimers();

    const killSignals: NodeJS.Signals[] = [];
    const child = createFakeChild((signal) => {
      killSignals.push(signal);
      if (signal === 'SIGKILL') {
        child.emit('close', null, 'SIGKILL');
      }
    });
    const spawnMock = vi.fn(() => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));

    const { spawnNodeScript } = await import('#tests/helpers/multi-process-driver.js');
    const resultPromise = spawnNodeScript({
      scriptPath: '/tmp/worker.cjs',
      args: [],
      env: { ...process.env },
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(killSignals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(SIGTERM_GRACE_MS - 1);
    expect(killSignals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(1);
    await expect(resultPromise).resolves.toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      parsed: undefined,
    });
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('uses node:path.delimiter when it composes PATH', async () => {
    const child = createFakeChild();
    const spawnMock = vi.fn(() => child);

    vi.doMock('node:child_process', () => ({
      spawn: spawnMock,
    }));
    vi.doMock('node:path', async (importOriginal) => {
      const actual = await importOriginal<typeof NodePath>();
      return {
        ...actual,
        delimiter: '|',
      };
    });

    const { spawnNodeScript } = await import('#tests/helpers/multi-process-driver.js');
    const resultPromise = spawnNodeScript({
      scriptPath: '/tmp/worker.cjs',
      args: ['vector'],
      env: {
        ...process.env,
        PATH: '/custom/bin',
      },
      timeoutMs: 1_000,
    });

    child.emit('close', 0, null);
    await resultPromise;

    const inheritedPath = process.env[currentPathKey()];
    const expectedPath =
      typeof inheritedPath === 'string' && inheritedPath.length > 0 ? `/custom/bin|${inheritedPath}` : '/custom/bin';

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['/tmp/worker.cjs', 'vector'],
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: expectedPath,
        }),
      }),
    );
  });
});
