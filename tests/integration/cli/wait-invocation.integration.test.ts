import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serializeWaitCursor } from '#src/jobs/wait.js';

const directory = mkdtempSync(join(tmpdir(), 'coral-wait-invocation-'));
const root = resolve('.');
const saved = serializeWaitCursor({ afterSeq: 7 });
const frontier = serializeWaitCursor({
  version: 'jobs.wait.v2',
  locations: { a: 'epoch' },
  positions: { epoch: 42 },
  deliveredJobIds: [],
});

function body(source: string, name: string, replacement: string): string {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const node = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node?.body) throw new Error(`No body for ${name}`);
  return source.slice(0, node.body.getStart(file)) + `{ ${replacement} }` + source.slice(node.body.end);
}

beforeAll(async () => {
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  for (const variant of [
    'real',
    'late-boundary',
    'no-backstop',
    'restart-budget',
    'discard-frontier',
    'monitor-abort',
  ]) {
    const outdir = join(directory, variant);
    await build({
      entryPoints: [join(root, 'tests/fixtures/wait-invocation/cli.mjs')],
      outfile: join(outdir, 'coral-cli.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      loader: { '.sql': 'text' },
      define: {
        'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'src/runtime/wrapper-entrypoint.ts')).href),
      },
      plugins: [
        {
          name: 'wait-boundary-fixture',
          setup(builder) {
            builder.onResolve({ filter: /^#src\// }, ({ path }) => ({
              path: join(root, path.replace('#src/', 'src/').replace(/\.js$/, '.ts')),
            }));
            builder.onLoad(
              { filter: /(?:wait-invocation|runner|handoff-target|ensure|program|follow|session)\.ts$/ },
              ({ path }) => {
                let source = readFileSync(path, 'utf8');
                if (path.endsWith('/cli/wait-invocation.ts')) {
                  source = source
                    .replace('const WAIT_BUDGET_MS = 590_000', 'const WAIT_BUDGET_MS = 600')
                    .replace('const WAIT_CLEANUP_MS = 10_000', 'const WAIT_CLEANUP_MS = 200')
                    .replace('const SNAPSHOT_BUDGET_MS = 30_000', 'const SNAPSHOT_BUDGET_MS = 600')
                    .replace('const SNAPSHOT_CLEANUP_MS = 1_000', 'const SNAPSHOT_CLEANUP_MS = 200');
                  if (variant === 'no-backstop') source = source.replace('process.exit(75)', 'undefined');
                  if (variant === 'monitor-abort')
                    source = source.replace(
                      'private readonly onSigint = () => this.stop()',
                      'private readonly onSigint = () => {}',
                    );
                }
                if (variant === 'monitor-abort' && path.endsWith('/cli/follow.ts'))
                  source = source.replaceAll("if (options.reconnectPolicy === 'until-terminal') process.", 'process.');
                if (variant === 'monitor-abort' && path.endsWith('/commands/session.ts'))
                  source = source.replace(
                    "reconnectPolicy: 'bounded',",
                    "reconnectPolicy: 'bounded', abortJobs: (ids) => client.abortJobs([...ids]),",
                  );
                if (path.endsWith('/cli/program.ts') && variant === 'late-boundary')
                  source = source.replace(
                    'mode === undefined ? undefined : new WaitInvocation(mode, argv)',
                    'undefined',
                  );
                if (path.endsWith('/handoff-routing/runner.ts')) {
                  source = body(source, 'resolveHandoffRoutingForOperation', 'return globalThis.waitProbe.routing();');
                  source = body(
                    source,
                    'publishHandoffTransition',
                    'return globalThis.waitProbe.publication(transition);',
                  );
                  source = source.replace(
                    'const childObservation = observeChild(child);',
                    'process.stderr.write(`OWNED_MONITOR:${child.pid}\\n`); const childObservation = observeChild(child);',
                  );
                  if (variant === 'restart-budget')
                    source = source.replace('remainingMs: waitInvocation.remainingMs()', 'remainingMs: 600');
                  if (variant === 'discard-frontier')
                    source = source.replace(
                      'invocation.saveContinuation(message.continuation, message.complete === true)',
                      'undefined',
                    );
                }
                if (path.endsWith('/infra/handoff-target.ts')) {
                  source = body(source, 'withValidatedHandoffTarget', 'return globalThis.waitProbe.execution;');
                  source = body(
                    source,
                    'inspectValidatedHandoffTarget',
                    'return { build: globalThis.waitProbe.execution.manifest };',
                  );
                }
                if (path.endsWith('/ipc/ensure.ts'))
                  source = body(source, 'ensure', 'return globalThis.waitProbe.ensure();');
                return { contents: source, loader: 'ts' };
              },
            );
            builder.onLoad({ filter: /wait-invocation\/cli\.mjs$/ }, ({ path }) => ({
              contents: readFileSync(path, 'utf8').replace('await runCli();', 'void runCli();'),
              loader: 'js',
            }));
          },
        },
      ],
    });
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
  }, 1_800);
  const sigint = interrupt
    ? setTimeout(() => {
        child.kill('SIGINT');
        setTimeout(() => child.kill('SIGINT'), 10);
      }, 250)
    : undefined;
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
    clearTimeout(sigint);
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
  } else expect(result.stdout).toContain(`Run coral-cli wait jobs a ghost --embed --cursor ${saved}`);
  if (scenario === 'late-delegation')
    expect(Number([...result.stderr.matchAll(/HANDLER_BUDGET:([\d.]+)/g)].at(-1)?.[1])).toBeLessThan(250);
});

it.each(['routing', 'selection', 'terminal', 'delegation', 'delegated-delivery'])(
  'two SIGINTs during %s never abort',
  async (scenario) => {
    const result = await probe(scenario, 'real', true);
    assertBounded(result);
  },
);

it('refuses an older target before starting an unbounded monitor', async () => {
  const result = await probe('old-target');
  expect(result.code).toBe(75);
  expect(result.timedOut).toBe(false);
  expect(result.stderr).toContain('cannot preserve this monitor invocation budget');
  expect(result.stderr).toContain(`coral-cli wait jobs a ghost --embed --cursor ${saved}`);
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
  const remaining = Number([...result.stderr.matchAll(/HANDLER_BUDGET:([\d.]+)/g)].at(-1)?.[1]);
  expect(remaining).toBeGreaterThan(250);
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
  if (scenario === 'sync') expect(result.elapsed).toBeGreaterThan(800);
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
    if (scenario === 'sync-delivery') expect(result.elapsed).toBeGreaterThan(800);
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
  expect(Number([...original.stderr.matchAll(/HANDLER_BUDGET:([\d.]+)/g)].at(-1)?.[1])).toBeLessThan(250);
  const control = await probe('late-delegation', 'restart-budget', false, true);
  expect(Number([...control.stderr.matchAll(/HANDLER_BUDGET:([\d.]+)/g)].at(-1)?.[1])).toBeGreaterThan(250);
});

it.each(['sync', 'delegated-sync'])('snapshot records the S2 synchronous-stall residual: %s', async (scenario) => {
  const result = await probe(scenario, 'real', false, true);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(75);
  expect(result.stdout).toContain('--now');
  expect(result.stdout.match(/Run coral-cli wait jobs/g)).toHaveLength(1);
  if (scenario === 'sync') expect(result.elapsed).toBeGreaterThan(800);
});
