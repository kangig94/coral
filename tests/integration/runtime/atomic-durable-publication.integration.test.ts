import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRealRuntime } from '#src/runtime/real.js';

const root = resolve('.');
const directory = mkdtempSync(join(tmpdir(), 'coral-atomic-publication-'));
const fixture = join(root, 'tests/fixtures/atomic-publication/writer.cjs');
const runFile = promisify(execFile);
const env = () => ({
  PATH: process.env.PATH,
  HOME: mkdtempSync(join(directory, 'home-')),
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
});

beforeAll(() => {
  for (const variant of ['real', 'shared', 'sweep'])
    symlinkSync(sharedFixture(`atomic-${variant}`), join(directory, `${variant}.cjs`));
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each(['real', 'shared'])(
  'four processes × 32 writes of 64 KB expose shared-stage contention: %s',
  async (variant) => {
    const target = join(directory, 'concurrent.json');
    writeFileSync(target, JSON.stringify({ padding: 'x'.repeat(64 * 1024), writer: 0, i: 0 }));
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        runFile(process.execPath, [fixture, join(directory, `${variant}.cjs`), target, 'concurrent'], {
          env: env(),
          timeout: 90_000,
        }),
      ),
    );
    const totals = results.map(
      (result) => JSON.parse(result.stdout) as { failed: number; invalid: number; count: number },
    );
    if (variant === 'real') for (const result of totals) expect(result).toEqual({ failed: 0, invalid: 0, count: 32 });
    else expect(totals.some((result) => result.failed > 0 || result.invalid > 0)).toBe(true);
    expect(readdirSync(directory).filter((name) => name.includes('.stage-'))).toEqual([]);
  },
);

it.each(['real', 'shared'])('held-fd corruption control: %s', (variant) => {
  const target = join(directory, `${variant}-held.json`);
  const stage = `${target}.tmp`;
  const fd = openSync(stage, 'w');
  try {
    writeSync(fd, Buffer.from('original'));
    execFileSync(process.execPath, [fixture, join(directory, `${variant}.cjs`), target, 'once'], {
      env: env(),
      timeout: 10_000,
    });
    writeSync(fd, Buffer.from('CORRUPTED'), 0, 9, 0);
    if (variant === 'shared') expect(() => JSON.parse(readFileSync(target, 'utf8'))).toThrow(SyntaxError);
    else expect(JSON.parse(readFileSync(target, 'utf8')).padding).toHaveLength(1024);
  } finally {
    closeSync(fd);
  }
});

it.each(['real', 'sweep'])('a paused writer still owns its stage after 25 hours: %s', async (variant) => {
  const target = join(directory, `aged-${variant}.json`);
  const child = spawn(process.execPath, [fixture, join(directory, 'real.cjs'), target, 'held'], {
    env: env(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ending = new Promise<number | null>((resolveEnd, reject) => {
    child.once('error', reject);
    child.once('exit', resolveEnd);
  });
  const ready = new Promise<string>((resolveReady, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('\n')) resolveReady(stdout.slice(0, stdout.indexOf('\n')));
    });
    void ending.then((code) => reject(new Error(`writer exited ${code} before its stage was ready: ${stderr}`)));
  });
  try {
    const stage = await ready;
    expect(stage).toMatch(/\.stage-\d+-\d+-[a-f0-9-]+$/);
    expect(stage.endsWith('.json')).toBe(false);
    const aged = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(stage, aged, aged);
    await runFile(process.execPath, [fixture, join(directory, `${variant}.cjs`), target, 'once'], {
      env: env(),
      timeout: 10_000,
    });
    expect(existsSync(stage)).toBe(variant === 'real');
    child.stdin.write('r');
    expect(await ending).toBe(variant === 'real' ? 0 : 1);
    if (variant === 'sweep') expect(stderr).toContain('owned publication failed');
  } finally {
    child.kill('SIGKILL');
  }
});

it('cleans only its own stage when publication fails', () => {
  const target = join(directory, 'directory-target');
  const runtime = createRealRuntime('prod', { baseDir: directory });
  runtime.storage.mkdirSync(target);
  const sibling = `${target}.stage-paused-writer`;
  writeFileSync(sibling, 'still owned');
  expect(() => runtime.storage.writeAtomicDurableSync(target, 'content')).toThrow();
  expect(readdirSync(directory).filter((name) => name.startsWith('directory-target.stage-'))).toEqual([
    'directory-target.stage-paused-writer',
  ]);
});
