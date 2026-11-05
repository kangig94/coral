import { spawn } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type * as NodeProcessModule from '#src/infra/node-process.js';
import type * as HandoffTargetModule from '#src/infra/handoff-target.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { validatedRunningBuildRoot } from '#src/infra/installed-build-root.js';
import { probeProcessIncarnation } from '#src/infra/node-process.js';
import { recordLegacyUpgradeIntent, requestLegacyUpgrade } from '#src/coordinator-launch/request.js';
import { resumeLegacyUpgradeObservation, startReplacementSupervisor } from '#src/runtime/supervisor-loss.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

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

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  root = mkdtempSync(join(tmpdir(), 'coral-sentinel-launch-log-'));
  runDir = join(root, 'gen2', 'run');
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
  for (const result of vi.mocked(spawn).mock.results) {
    if (result.type !== 'return') continue;
    const child = result.value;
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

async function expectSentinelDiagnostics(): Promise<void> {
  expect(spawn).toHaveBeenCalledOnce();
  const result = vi.mocked(spawn).mock.results[0];
  if (result.type !== 'return') throw new Error('Fixture sentinel did not spawn');
  const child = result.value;
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  const log = readFileSync(join(runDir, 'coordinator.log'), 'utf8');
  expect(child.exitCode, log).toBe(0);
  expect(log).toContain('sentinel-launch-diagnostic\n');
}

it('retains replacement sentinel stderr in the run-dir log', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  startReplacementSupervisor(root, runDir, manifest, vi.fn(), async () => {});
  await expectSentinelDiagnostics();
});

it('retains legacy-upgrade request sentinel stderr in the run-dir log', async () => {
  const result = await requestLegacyUpgrade({
    runDir,
    requestId: 'request-test',
    incumbent,
    target: { build: manifest, pluginRootLabel: root },
  });
  expect(result.kind).toBe('waiting');
  await expectSentinelDiagnostics();
});

it('retains legacy-upgrade observer sentinel stderr in the run-dir log', async () => {
  const result = await recordLegacyUpgradeIntent({
    runDir,
    requestId: 'observer-test',
    incumbent,
    target: { build: manifest, pluginRootLabel: root },
  });
  expect(result.kind).toBe('waiting');
  await resumeLegacyUpgradeObservation(runDir, root, manifest, 5_000);
  await expectSentinelDiagnostics();
});
