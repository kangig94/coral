import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';

const directory = mkdtempSync(join(tmpdir(), 'coral-wait-invocation-'));
const saved = serializeWaitCursor({ afterSeq: 7 });
const frontier = serializeWaitCursor({
  version: 'jobs.wait.v2',
  locations: { a: 'epoch' },
  positions: { epoch: 42 },
  deliveredJobIds: [],
});

beforeAll(() => {
  const outdir = join(directory, 'real');
  mkdirSync(outdir);
  symlinkSync(sharedFixture('wait-real'), join(outdir, 'coral-cli.cjs'));
  symlinkSync('coral-cli.cjs', join(outdir, 'coral-cli'));
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function probe(
  scenario: string,
  snapshot = false,
): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string; elapsed: number }> {
  const entry = join(directory, 'real', 'coral-cli.cjs');
  const start = performance.now();
  const home = mkdtempSync(join(directory, 'home-'));
  const target = entry;
  const child = spawn(
    process.execPath,
    [entry, 'wait', 'jobs', 'a', 'ghost', ...(snapshot ? ['--now'] : ['--embed']), '--cursor', saved],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LANG: 'C.UTF-8',
        TMPDIR: '/tmp',
        WAIT_PROBE_SCENARIO: scenario,
        WAIT_PROBE_MODE: snapshot ? 'snapshot' : 'bounded',
        WAIT_PROBE_TARGET: target,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const killer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 800);
  try {
    const code = await new Promise<number | null>((resolveEnd, reject) => {
      child.once('error', reject);
      child.once('close', resolveEnd);
    });
    return { code, timedOut, stdout, stderr, elapsed: performance.now() - start };
  } finally {
    clearTimeout(killer);
    child.kill('SIGKILL');
  }
}

function assertBounded(result: Awaited<ReturnType<typeof probe>>): void {
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(75);
  expect(result.elapsed).toBeLessThan(1_400);
  expect(result.stdout.match(/Run coral-cli wait jobs/g), result.stderr).toHaveLength(1);
  expect(result.stderr).not.toContain('ABORT MUST NOT RUN');
  expect(result.stderr).not.toContain('ABORT CALLED');
  for (const match of result.stderr.matchAll(/OWNED_MONITOR:(\d+)/g))
    expect(() => process.kill(Number(match[1]), 0)).toThrow();
}

it.each([false, true])('bounds a real delegated monitor, snapshot=%s', async (snapshot) => {
  const result = await probe('delegated-delivery', snapshot);
  assertBounded(result);
  if (snapshot) expect(result.stdout).toContain('--now');
  else {
    expect(result.stdout).toContain('confirmed delivery');
    expect(result.stdout).toContain(`--cursor ${frontier}`);
  }
});
