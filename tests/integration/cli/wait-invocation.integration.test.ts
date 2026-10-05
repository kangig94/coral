import { sharedFixture } from '#tests/helpers/shared-fixtures.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CLI_HANDOFF_GUARD_ENV } from '#src/coordinator/handoff-routing/wait-invocation.js';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';

const directory = mkdtempSync(join(tmpdir(), 'coral-wait-invocation-'));
const saved = serializeWaitCursor({ afterSeq: 7 });
const frontier = serializeWaitCursor({
  version: 'jobs.wait.v2',
  locations: { a: 'epoch' },
  positions: { epoch: 42 },
  deliveredJobIds: [],
});

beforeAll(async () => {
  for (const variant of [
    'real',
    'late-boundary',
    'no-backstop',
    'restart-budget',
    'discard-frontier',
    'monitor-abort',
  ]) {
    const outdir = join(directory, variant);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outdir);
    symlinkSync(sharedFixture(`wait-${variant}`), join(outdir, 'coral-cli.cjs'));
    symlinkSync('coral-cli.cjs', join(outdir, 'coral-cli'));
  }
  const old = join(directory, 'old');
  writeFileSync(join(directory, 'old-cli.cjs'), 'console.error("unknown option"); process.exit(2);');
  // The selected filename is fixed by the handoff contract.
  const { mkdirSync, copyFileSync } = await import('node:fs');
  mkdirSync(old);
  copyFileSync(join(directory, 'old-cli.cjs'), join(old, 'coral-cli.cjs'));
  symlinkSync('coral-cli.cjs', join(old, 'coral-cli'));
  const hanging = join(directory, 'hanging');
  mkdirSync(hanging);
  writeFileSync(
    join(hanging, 'coral-cli'),
    `require('node:fs').writeFileSync(require('node:path').join(process.env.HOME, 'contract-probe.pid'), String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);`,
  );
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function probe(
  scenario: string,
  variant = 'real',
  interrupt = false,
  snapshot = false,
): Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string; elapsed: number }> {
  const entry = join(directory, variant, 'coral-cli.cjs');
  const start = performance.now();
  const home = mkdtempSync(join(directory, 'home-'));
  const target =
    scenario === 'old-target'
      ? join(directory, 'old', 'coral-cli.cjs')
      : scenario === 'old-hanging-target'
        ? join(directory, 'hanging', 'coral-cli')
        : entry;
  const child = spawn(
    process.execPath,
    [entry, 'wait', 'jobs', 'a', 'ghost', ...(snapshot ? ['--now'] : ['--embed']), '--cursor', saved],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LANG: 'C.UTF-8',
        TMPDIR: '/tmp',
        ...(scenario === 'legacy-parent' ? { [CLI_HANDOFF_GUARD_ENV]: '1' } : {}),
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
  let interrupted = false;
  let secondInterrupt: NodeJS.Timeout | undefined;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (interrupt && !interrupted && stderr.includes('INTERRUPT_READY')) {
      interrupted = true;
      child.kill('SIGINT');
      secondInterrupt = setTimeout(() => child.kill('SIGINT'), 10);
    }
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
    if (scenario === 'old-hanging-target')
      expect(() => process.kill(Number(readFileSync(join(home, 'contract-probe.pid'), 'utf8')), 0)).toThrow();
    return { code, timedOut, stdout, stderr, elapsed: performance.now() - start };
  } finally {
    clearTimeout(killer);
    clearTimeout(secondInterrupt);
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

it.each([
  'routing',
  'selection',
  'terminal',
  'bootstrap',
  'opening',
  'silent',
  'backoff',
  'close',
  'delegation',
  'delegated-delivery',
  'late-delegation',
  'ignores-cancel',
])('%s consumes one invocation budget', async (scenario) => {
  const result = await probe(scenario);
  assertBounded(result);
  if (['delegated-delivery', 'late-delegation', 'close'].includes(scenario)) {
    expect(result.stdout).toContain('confirmed delivery');
    expect(result.stdout).toContain(`--cursor ${frontier}`);
    expect(result.stdout).not.toContain('wait jobs a ghost');
  } else if (scenario === 'silent') {
    expect(result.stdout).toContain('Still waiting on 2 jobs.');
    expect(result.stdout).toContain(`--cursor ${saved}`);
    expect(result.stdout).not.toContain('admission did not complete');
  } else expect(result.stdout).toContain(`Run coral-cli wait jobs a ghost --embed --cursor ${saved}`);
  if (scenario === 'late-delegation')
    expect(Number([...result.stderr.matchAll(/HANDLER_BUDGET:([\d.]+)/g)].at(-1)?.[1])).toBeLessThan(330);
});

it.each(['routing', 'selection', 'terminal', 'delegation', 'delegated-delivery', 'silent'])(
  'two SIGINTs during %s never abort',
  async (scenario) => {
    const result = await probe(scenario, 'real', true);
    assertBounded(result);
  },
);

it('continues in the current build after a deterministic older-target contract mismatch', async () => {
  const result = await probe('old-target');
  expect(result.code).toBe(75);
  expect(result.timedOut).toBe(false);
  expect(result.stderr).not.toContain('cannot preserve this monitor invocation budget');
  expect(result.stderr).toContain('HANDLER_BUDGET:');
  expect(result.stdout).toContain(`--cursor ${saved}`);
  expect(result.stderr).not.toContain('OWNED_MONITOR:');
});

it('bounds and kills a stalled older-target capability probe', async () => {
  const result = await probe('old-hanging-target');
  assertBounded(result);
  expect(result.stderr).not.toContain('OWNED_MONITOR:');
});

it('restoring monitor abort fails the no-abort assertion', async () => {
  const result = await probe('silent', 'monitor-abort', true);
  expect(result.stderr).toContain('ABORT CALLED');
  expect(() => assertBounded(result)).toThrow();
});

it.each(['late-boundary', 'no-backstop'])('negative control %s fails the bounded-exit assertion', async (variant) => {
  const result = await probe('routing', variant);
  expect(result.timedOut).toBe(true);
  expect(() => assertBounded(result)).toThrow();
});

it('restarting the delegated budget fails the remaining-duration assertion', async () => {
  const result = await probe('late-delegation', 'restart-budget');
  assertBounded(result);
  const remaining = Number([...result.stderr.matchAll(/HANDOFF_BUDGET:([\d.]+)/g)].at(-1)?.[1]);
  expect(remaining).toBeGreaterThan(330);
});

it('discarding delegated delivery fails the frozen-frontier assertion', async () => {
  const result = await probe('delegated-delivery', 'discard-frontier');
  assertBounded(result);
  expect(result.stdout).toContain('confirmed delivery');
  expect(result.stdout).not.toContain(`--cursor ${frontier}`);
  expect(result.stdout).toContain(`--cursor ${saved}`);
});

it.each(['sync', 'delegated-sync'])('records S2 synchronous-stall residual: %s', async (scenario) => {
  const result = await probe(scenario);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(75);
  expect(result.stdout.match(/Run coral-cli wait jobs/g), result.stderr).toHaveLength(1);
  if (scenario === 'sync') expect(result.elapsed).toBeGreaterThan(400);
  else assertBounded(result);
});

it.each(['sync-delivery', 'delegated-sync-delivery'])(
  '%s preserves delivery before a synchronous stall',
  async (scenario) => {
    const result = await probe(scenario);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(75);
    expect(result.stdout.match(/Run coral-cli wait jobs/g), result.stderr).toHaveLength(1);
    expect(result.stdout).toContain(`--cursor ${frontier}`);
    expect(result.stdout).not.toContain('wait jobs a ghost');
    if (scenario === 'sync-delivery') expect(result.elapsed).toBeGreaterThan(400);
    else assertBounded(result);
  },
);

it.each(['routing', 'selection', 'terminal', 'bootstrap', 'opening', 'delegation'])(
  'snapshot bounds %s from the original invocation before admission',
  async (scenario) => {
    const result = await probe(scenario, 'real', false, true);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(75);
    expect(result.elapsed).toBeLessThan(1400);
    expect(result.stdout).toContain('--now');
    expect(result.stdout).not.toContain('Cursor:');
    expect(result.stderr).not.toContain('ABORT CALLED');
    expect(result.stdout.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  },
);

it.each(['late-boundary', 'no-backstop'])(
  'snapshot negative control %s fails the original invocation bound',
  async (variant) => {
    const result = await probe('routing', variant, false, true);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).not.toContain('Cursor:');
  },
);

it('snapshot delegation cannot restart the invocation budget', async () => {
  const original = await probe('late-delegation', 'real', false, true);
  assertBounded(original);
  expect(original.stdout).toContain('--now');
  expect(Number([...original.stderr.matchAll(/HANDLER_BUDGET:([\d.]+)/g)].at(-1)?.[1])).toBeLessThan(330);
});

it('snapshot delegated budget restart is detected by its negative control', async () => {
  const control = await probe('late-delegation', 'restart-budget', false, true);
  expect(Number([...control.stderr.matchAll(/HANDOFF_BUDGET:([\d.]+)/g)].at(-1)?.[1])).toBeGreaterThan(330);
});

it.each(['sync', 'delegated-sync'])('snapshot records the S2 synchronous-stall residual: %s', async (scenario) => {
  const result = await probe(scenario, 'real', false, true);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(75);
  expect(result.stdout).toContain('--now');
  expect(result.stdout.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  if (scenario === 'sync') expect(result.elapsed).toBeGreaterThan(400);
});

it('freezes delegated output before printing the parent continuation', async () => {
  const result = await probe('late-child-output');
  assertBounded(result);
  expect(result.stdout).toContain('confirmed delivery');
  expect(result.stdout).toContain('late child output');
  expect(result.stdout.indexOf('late child output')).toBeLessThan(result.stdout.indexOf('Run coral-cli wait jobs'));
  expect(result.stdout.slice(result.stdout.indexOf('Run coral-cli wait jobs'))).not.toContain('late child output');
  expect(result.stdout.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  expect(result.stdout).toContain(`--cursor ${frontier}`);
});

it.each([false, true])('a released parent gets a bounded, admitted wait, snapshot=%s', async (snapshot) => {
  const result = await probe('legacy-parent', 'real', false, snapshot);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(75);
  expect(result.stdout).toContain(`--cursor ${saved}`);
  expect(result.stdout.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  expect(result.stderr).toContain('HANDLER_BUDGET:');
});
