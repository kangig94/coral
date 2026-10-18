import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pendingRequestCandidate } from '#src/coordinator-launch/active-child.js';
import type * as ExecutableModule from '#src/coordinator-launch/executable.js';
import { compareAndSwapUpgradeIntent, type UpgradeIntent } from '#src/infra/upgrade-intent.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const target = {
  version: '0.10.20',
  buildSetId: '00000000-0000-4000-8000-000000000020',
  flavor: 'prod' as const,
  storeFormatFingerprint: `sha256:${'0'.repeat(64)}`,
  bundleHash: '0123456789abcdef',
  cliBundleHash: '0123456789abcdef',
  claudeAppserverBundleHash: '0123456789abcdef',
  durableWrapperBundleHash: '0123456789abcdef',
};

vi.mock('#src/coordinator-launch/executable.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecutableModule>()),
  targetValidation: () => target,
}));

const serving = {
  identity: { pid: 4_242, incarnation: testIncarnation(4_242) },
  manifest: { ...target, version: '0.10.19', buildSetId: '00000000-0000-4000-8000-000000000019' },
};

const runDirs: string[] = [];
afterEach(() => {
  for (const dir of runDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runDirWithIntent(
  disposition: UpgradeIntent['disposition'],
  recorded: typeof serving.identity = serving.identity,
): Promise<string> {
  const runDir = mkdtempSync(join(tmpdir(), 'coral-active-child-'));
  runDirs.push(runDir);
  const written = await compareAndSwapUpgradeIntent(runDir, null, {
    requestId: 'request-1',
    legacyRetirement: true,
    incumbent: {
      instanceId: 'incumbent',
      pid: recorded.pid,
      incarnation: recorded.incarnation,
      version: serving.manifest.version,
      bundleHash: serving.manifest.bundleHash,
      flavor: 'prod',
    },
    target: { build: target, pluginRootLabel: '/plugins/coral/0.10.20' },
    attemptId: null,
    attemptOwner: null,
    disposition,
    blockers: [],
    retryCondition: null,
    attemptDeadline: null,
    completionReceipt: null,
  });
  if (written.kind !== 'written') throw new Error(`intent seed was ${written.kind}`);
  return runDir;
}

describe('active-child', () => {
  it('should not dispatch a contender against a serving child that holds the request as its own deferral', async () => {
    const runDir = await runDirWithIntent('deferred');
    expect(pendingRequestCandidate(runDir, serving, new Map())).toBeNull();
  });

  it('should not dispatch a contender while the serving child holds its own attempt', async () => {
    const runDir = await runDirWithIntent('attempting');
    expect(pendingRequestCandidate(runDir, serving, new Map())).toBeNull();
  });

  it('should dispatch a contender to deliver a pending request', async () => {
    const runDir = await runDirWithIntent('pending');
    expect(pendingRequestCandidate(runDir, serving, new Map())).toMatchObject({
      requestId: 'request-1',
      executable: '/plugins/coral/0.10.20/bridge/coral-backend.cjs',
    });
  });

  it('should dispatch a contender when the deferral names an earlier incarnation of the same pid', async () => {
    const runDir = await runDirWithIntent('deferred', {
      pid: serving.identity.pid,
      incarnation: testIncarnation('earlier'),
    });
    expect(pendingRequestCandidate(runDir, serving, new Map())).toMatchObject({ requestId: 'request-1' });
  });
});
