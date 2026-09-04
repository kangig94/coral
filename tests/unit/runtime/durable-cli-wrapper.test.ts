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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe('durable-cli-wrapper', () => {
  it('flushes its complete exit record while its stdout reader is paused', async () => {
    const rootDir = createTempDir();
    const jobDir = join(rootDir, 'job');
    const wrapperPath = join(rootDir, 'durable-cli-wrapper.mjs');
    const childExitedPath = join(rootDir, 'child-exited');
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
    const wrapper = spawn(
      process.execPath,
      [wrapperPath, jobDir, process.execPath, JSON.stringify(['-e', childScript]), '', '', '\u0001'.repeat(120_000)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stdout = wrapper.stdout;
    const stderr = wrapper.stderr;
    if (stdout === null || stderr === null) throw new Error('Expected wrapper control pipes');

    let exited = false;
    wrapper.once('exit', () => {
      exited = true;
    });
    stdout.pause();

    try {
      await waitForFile(childExitedPath);
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
