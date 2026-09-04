import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

const createdDirs: string[] = [];

afterEach(() => {
  for (const dir of createdDirs.splice(0, createdDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coral-durable-wrapper-'));
  createdDirs.push(dir);
  return dir;
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('durable-cli-wrapper', () => {
  it('does not spawn a provider after termination wins the publication gate', async () => {
    const rootDir = createTempDir();
    const jobDir = join(rootDir, 'job');
    const wrapperPath = join(rootDir, 'durable-cli-wrapper.mjs');
    const spawnLogPath = join(rootDir, 'spawn-log');
    const providerStartedPath = join(rootDir, 'provider-started');
    const launchPayloadPath = join(jobDir, 'launch.v1.json');
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, 'env.json'), '{}');

    await build({
      entryPoints: [fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: wrapperPath,
      plugins: [
        {
          name: 'spawn-observer',
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^node:child_process$/, namespace: 'file' }, () => ({
              path: 'spawn-observer',
              namespace: 'spawn-observer',
            }));
            pluginBuild.onLoad({ filter: /.*/, namespace: 'spawn-observer' }, () => ({
              loader: 'js',
              contents: `
                import { execFile, execFileSync, spawn as realSpawn } from 'node:child_process';
                import { appendFileSync } from 'node:fs';
                export { execFile, execFileSync };
                export const spawn = (...args) => {
                  appendFileSync(${JSON.stringify(spawnLogPath)}, JSON.stringify(args.slice(0, 2)) + '\\n');
                  return realSpawn(...args);
                };
              `,
            }));
          },
        },
      ],
    });

    writeFileSync(
      launchPayloadPath,
      JSON.stringify({
        version: 1,
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(providerStartedPath)}, 'started')`],
        cwd: null,
        prompt: '',
        startTime: new Date().toISOString(),
      }),
    );
    const wrapper = spawn(process.execPath, [wrapperPath, launchPayloadPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      wrapper.once('error', reject);
      wrapper.once('close', (code, signal) => resolve({ code, signal }));
    });
    wrapper.stdout?.resume();
    wrapper.stderr?.resume();

    await waitForFile(join(jobDir, 'stderr'));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(wrapper.kill('SIGTERM')).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (wrapper.connected) wrapper.send('runtime-start-published', () => undefined);

    const close = await closePromise;

    expect(close).toEqual({ code: 0, signal: null });
    expect(existsSync(spawnLogPath)).toBe(false);
    expect(existsSync(providerStartedPath)).toBe(false);
  });

  it('flushes its complete exit record while its stdout reader is paused', async () => {
    const rootDir = createTempDir();
    const jobDir = join(rootDir, 'job');
    const wrapperPath = join(rootDir, 'durable-cli-wrapper.mjs');
    const childExitedPath = join(rootDir, 'child-exited');
    const launchPayloadPath = join(jobDir, 'launch.v1.json');
    mkdirSync(jobDir);
    writeFileSync(join(jobDir, 'env.json'), '{}');

    await build({
      entryPoints: [fileURLToPath(new URL('../../../src/runtime/durable-cli-wrapper.ts', import.meta.url))],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: wrapperPath,
    });

    const childScript = `require('node:fs').writeFileSync(${JSON.stringify(childExitedPath)}, 'done')`;
    writeFileSync(
      launchPayloadPath,
      JSON.stringify({
        version: 1,
        command: process.execPath,
        args: ['-e', childScript],
        cwd: null,
        prompt: '',
        startTime: '\u0001'.repeat(120_000),
      }),
    );
    const wrapper = spawn(process.execPath, [wrapperPath, launchPayloadPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const stdout = wrapper.stdout;
    const stderr = wrapper.stderr;
    if (stdout === null || stderr === null) throw new Error('Expected wrapper control pipes');

    let exited = false;
    wrapper.once('exit', () => {
      exited = true;
    });
    stdout.pause();
    wrapper.send('runtime-start-published');

    try {
      await waitForFile(childExitedPath, 5_000);
      expect(existsSync(launchPayloadPath)).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(exited).toBe(false);

      let controlOutput = '';
      let errorOutput = '';
      stdout.on('data', (chunk: Buffer) => {
        controlOutput += chunk.toString();
      });
      stderr.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });
      stdout.resume();

      const close = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        wrapper.once('error', reject);
        wrapper.once('close', (code, signal) => resolve({ code, signal }));
      });
      const records = controlOutput
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string });

      expect(close).toEqual({ code: 0, signal: null });
      expect(errorOutput).toBe('');
      expect(records.map((record) => record.type)).toEqual(['runtime', 'exit']);
      expect(records.at(-1)).toMatchObject({
        type: 'exit',
        exitRecord: { exitCode: 0, signal: null, endTime: expect.any(String) },
      });
    } finally {
      if (!exited) {
        wrapper.kill('SIGKILL');
        await new Promise<void>((resolve) => wrapper.once('close', () => resolve()));
      }
    }
  });
});
