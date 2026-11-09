import { compareAndSwapUpgradeIntent, readUpgradeIntent } from '#src/infra/upgrade-intent.js';
import { failedAttemptRetry } from '#src/coordinator/succession/attempt-retry.js';
import { execFile, spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type * as NodeProcessModule from '#src/infra/node-process.js';
import type * as HandoffTargetModule from '#src/infra/handoff-target.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { validatedRunningBuildRoot } from '#src/infra/installed-build-root.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { recordLegacyUpgradeIntent, requestLegacyUpgrade } from '#src/coordinator-launch/request.js';
import { resumeLegacyUpgradeObservation, startReplacementSupervisor } from '#src/runtime/supervisor-loss.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { Runtime } from '#src/runtime/ports.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('#src/infra/installed-build-root.js', () => ({ validatedRunningBuildRoot: vi.fn() }));
vi.mock('#src/infra/node-process.js', async (original) => ({
  ...(await original<typeof NodeProcessModule>()),
  probeProcessIncarnation: vi.fn(),
}));
vi.mock('#src/infra/handoff-target.js', async (original) => ({
  ...(await original<typeof HandoffTargetModule>()),
  createForeignTargetValidator: () => () => ({ kind: 'validated' }),
}));

const manifest: StrictBundleManifest = {
  version: '0.10.28',
  buildSetId: '00000000-0000-4000-8000-000000000001',
  flavor: 'prod',
  storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};
const incumbent = {
  instanceId: 'source-test',
  pid: process.pid,
  incarnation: testIncarnation('source-test'),
  version: '0.10.27',
  bundleHash: 'fedcba9876543210',
  flavor: 'prod' as const,
};
let root: string;
let runDir: string;
let runtime: Runtime;

async function withinDeadline<T>(work: Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(10_000);
  let expired = () => {};
  const deadline = new Promise<never>((_, reject) => {
    expired = () => reject(new Error('Fixture operation timed out', { cause: signal.reason }));
    signal.addEventListener('abort', expired, { once: true });
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    signal.removeEventListener('abort', expired);
  }
}

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  root = mkdtempSync(join(tmpdir(), 'coral-sentinel-launch-log-'));
  runDir = join(root, 'gen2', 'run');
  mkdirSync(runDir, { recursive: true });
  runtime = createRealRuntime('prod', { baseDir: root });
  mkdirSync(join(root, 'bridge'));
  writeFileSync(join(root, 'bridge', 'coral-backend.cjs'), '');
  writeFileSync(
    join(root, 'bridge', 'coral-sentinel.cjs'),
    `
    process.stderr.write('sentinel-launch-diagnostic\\n');
    if (process.env.CORAL_OBSERVATION_CHALLENGE) {
      process.send({ kind: 'coral-observation-owned', challenge: process.env.CORAL_OBSERVATION_CHALLENGE });
    } else if (process.connected) process.disconnect();
  `,
  );
  vi.mocked(validatedRunningBuildRoot).mockReturnValue(root);
  vi.mocked(probeProcessIncarnation).mockReturnValue(incumbent.incarnation);
});

afterEach(async () => {
  try {
    await Promise.all(
      vi.mocked(spawn).mock.results.map(async (result) => {
        if (result.type !== 'return') return;
        const child = result.value;
        if (child.connected) child.disconnect();
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
          child.kill('SIGKILL');
          await exited;
        }
      }),
    );
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});

async function expectSentinelDiagnostics(): Promise<void> {
  expect(spawn).toHaveBeenCalledOnce();
  const result = vi.mocked(spawn).mock.results[0];
  if (result.type !== 'return') throw new Error('Fixture sentinel did not spawn');
  const child = result.value;
  if (child.exitCode === null && child.signalCode === null)
    await once(child, 'exit', { signal: AbortSignal.timeout(10_000) });
  expect(child.exitCode).toBe(0);
  expect(readFileSync(join(runDir, 'coordinator-logs/native-stderr.log'), 'utf8')).toContain(
    'sentinel-launch-diagnostic\n',
  );
}

it('retains replacement sentinel stderr in the run-dir log', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  startReplacementSupervisor(root, runDir, manifest, vi.fn(), async () => {}, runtime);
  await expectSentinelDiagnostics();
});

it('retains legacy-upgrade request sentinel stderr in the run-dir log', async () => {
  const result = await withinDeadline(
    requestLegacyUpgrade({
      runDir,
      requestId: 'request-test',
      incumbent,
      target: { build: manifest, pluginRootLabel: root },
    }),
  );
  expect(result.kind).toBe('waiting');
  await expectSentinelDiagnostics();
});

it('retains legacy-upgrade observer sentinel stderr in the run-dir log', async () => {
  const result = await withinDeadline(
    recordLegacyUpgradeIntent({
      runDir,
      requestId: 'observer-test',
      incumbent,
      target: { build: manifest, pluginRootLabel: root },
    }),
  );
  expect(result.kind).toBe('waiting');
  await withinDeadline(resumeLegacyUpgradeObservation(runDir, root, manifest, 5_000));
  await expectSentinelDiagnostics();
});

it('queues a legacy request behind committed retirement without losing ordinary startup', async () => {
  const target = { build: manifest, pluginRootLabel: root };
  expect(
    (await withinDeadline(recordLegacyUpgradeIntent({ runDir, requestId: 'retiring', incumbent, target }))).kind,
  ).toBe('waiting');
  const read = readUpgradeIntent(runDir);
  if (read.kind !== 'readable') throw new Error(read.kind);
  let intent = read.intent;
  for (let i = 0; i < 2; i++)
    intent = {
      ...intent,
      ...failedAttemptRetry(
        intent,
        { kind: 'transient', retryAfterMs: 1000, servingDeadline: true },
        'changed',
        Date.now(),
      ),
    };
  const policy = intent.servingDeadline;
  if (policy === undefined) throw new Error('missing deadline policy');
  expect(
    (
      await withinDeadline(
        compareAndSwapUpgradeIntent(runDir, intent.revision, {
          ...intent,
          servingDeadline: { ...policy, outcome: 'retiring', retirementIncumbent: incumbent.instanceId },
        }),
      )
    ).kind,
  ).toBe('written');
  const newer = { ...target, build: { ...manifest, version: '0.10.29', buildSetId: 'queued-build' } };
  expect(
    await withinDeadline(recordLegacyUpgradeIntent({ runDir, requestId: 'queued', incumbent, target: newer })),
  ).toMatchObject({
    kind: 'waiting',
    requestId: 'queued',
  });
  expect(readUpgradeIntent(runDir)).toMatchObject({
    intent: {
      requestId: 'retiring',
      target,
      legacyRetirement: true,
      nextTarget: { requestId: 'queued', target: newer },
    },
  });
  expect(spawn).not.toHaveBeenCalled();
});

it.each(['supervisor', 'legacy'] as const)(
  'keeps handled %s startup failure text in bounded supervisor diagnostics',
  async (mode) => {
    const harness = join(root, 'rejecting-sentinel.cjs');
    await withinDeadline(
      build({
        entryPoints: [fileURLToPath(new URL('../../../src/coordinator-launch/main.ts', import.meta.url))],
        outfile: harness,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        plugins: [
          {
            name: 'reject-startup',
            setup(plugin) {
              plugin.onResolve({ filter: /^\.\/(supervisor|legacy-bootstrap)\.js$/ }, (args) =>
                args.importer.endsWith('/coordinator-launch/main.ts')
                  ? { path: args.path, namespace: 'startup-failure' }
                  : undefined,
              );
              plugin.onLoad({ filter: /.*/, namespace: 'startup-failure' }, (args) => ({
                contents:
                  args.path === './supervisor.js'
                    ? `export async function runNamespaceSupervisor() { throw new Error('handled-supervisor-failure'); }`
                    : `export async function launchLegacyBackend() { throw new Error('handled-legacy-failure'); }`,
              }));
            },
          },
        ],
      }),
    );
    const args = mode === 'legacy' ? ['--launch-legacy', '/fixture/backend.cjs'] : ['/fixture/backend.cjs'];
    await expect(
      promisify(execFile)(process.execPath, [harness, ...args], {
        env: { ...process.env, CORAL_SENTINEL_RUN_DIR: runDir },
        timeout: 10_000,
        killSignal: 'SIGKILL',
      }),
    ).rejects.toMatchObject({ code: 1, stderr: '' });
    const pointer = JSON.parse(readFileSync(join(runDir, 'coordinator-logs/latest-supervisor.json'), 'utf8')) as {
      path: string;
    };
    expect(readFileSync(pointer.path, 'utf8')).toMatch(
      new RegExp(`^Error: handled-${mode}-failure\\nsupervisor \\d+ exited with code 1\\n$`, 'u'),
    );
  },
);
