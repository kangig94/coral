import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { launchAndFollow } from '#src/cli/follow.js';
import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { createForeignTargetValidator, type ValidatedHandoffTarget } from '#src/infra/handoff-target.js';

const mockState = vi.hoisted(() => ({
  ensure: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

const fixtureRoots: string[] = [];
const validateForeignTarget = createForeignTargetValidator();
const waitTiming = {
  origin: 'runtime',
  originAt: '2026-08-04T08:00:00.000Z',
  emittedAt: '2026-08-04T08:00:01.000Z',
  elapsedMs: 1_000,
} as const;

function bundleHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function createReplayTarget(tracePath: string): ValidatedHandoffTarget {
  const root = mkdtempSync(join(tmpdir(), 'coral-cross-version-follow-'));
  const bundleDir = join(root, 'bundle');
  fixtureRoots.push(root);
  mkdirSync(bundleDir);

  const cliBundle = [
    "const { appendFileSync } = require('node:fs');",
    `const tracePath = ${JSON.stringify(tracePath)};`,
    "const cursorIndex = process.argv.indexOf('--cursor');",
    "const cursor = JSON.parse(Buffer.from(process.argv[cursorIndex + 1], 'base64url').toString('utf8'));",
    "const waitingAcknowledged = cursor.snapshotAcks?.some(({ key, id }) => key.startsWith('waiting:') && id === 'waiting-v1');",
    "if (!waitingAcknowledged) appendFileSync(tracePath, 'waiting-duplicate\\n');",
    "for (const event of [{ seq: 1, line: 'old-one' }, { seq: 2, line: 'old-two' }, { seq: 3, line: 'new-three' }, { seq: 4, line: 'new-four' }]) {",
    '  if (event.seq <= cursor.afterSeq) continue;',
    '  appendFileSync(tracePath, `${event.line}\\n`);',
    '  process.stdout.write(`${event.line}\\n`);',
    '}',
  ].join('\n');
  const backendBundle = 'cross-version follow backend fixture';
  const appserverBundle = 'cross-version follow appserver fixture';
  const manifest: StrictBundleManifest = {
    version: '2.0.0',
    buildSetId: '123e4567-e89b-42d3-a456-426614174000',
    bundleHash: bundleHash(backendBundle),
    cliBundleHash: bundleHash(cliBundle),
    claudeAppserverBundleHash: bundleHash(appserverBundle),
    flavor: 'prod',
    storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
  };

  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), appserverBundle, 'utf8');
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

  const validation = validateForeignTarget(bundleDir, manifest);
  if (validation.kind !== 'validated') {
    throw new Error(`Replay target validation failed: ${validation.evidence.failure}`);
  }
  return validation.target;
}

function useCurrentRouting() {
  return { kind: 'use-current', evidence: { source: 'current-build' } } as const;
}

function makeBackend(routing: unknown, subscribe = vi.fn()) {
  return {
    socketPath: '/tmp/coordinator.sock',
    instanceId: 'backend-1',
    bundleHash: 'bundle-hash',
    flavor: 'prod' as const,
    namespace: 'namespace',
    host: '127.0.0.1',
    port: 4100,
    token: 'token',
    version: '1.0.0',
    routing,
    request: vi.fn(),
    subscribe,
    ping: vi.fn(),
    health: vi.fn(),
    shutdown: vi.fn(),
  };
}

function makeSubscription(events: readonly WaitStreamEvent[]) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

afterEach(() => {
  process.exitCode = undefined;
  mockState.ensure.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-version follow', () => {
  it('should replay journal output across a real handoff without duplicated or dropped lines', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'coral-cross-version-follow-trace-'));
    const tracePath = join(traceRoot, 'trace.txt');
    fixtureRoots.push(traceRoot);
    const target = createReplayTarget(tracePath);
    const events = [
      {
        type: 'progress',
        jobId: 'job-1',
        seq: 1,
        message: 'old-one',
        timing: waitTiming,
      },
      {
        type: 'progress',
        jobId: 'job-1',
        seq: 2,
        message: 'old-two',
        timing: waitTiming,
      },
      {
        type: 'waiting',
        waitingJobIds: ['job-1'],
        snapshotRenderId: 'waiting-v1',
      },
    ] as WaitStreamEvent[];
    const subscribe = vi.fn().mockResolvedValue(makeSubscription(events));
    let stdout = '';

    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      const text = chunk.toString();
      stdout += text;
      if (text.includes('old-one')) appendFileSync(tracePath, 'old-one\n');
      if (text.includes('old-two')) appendFileSync(tracePath, 'old-two\n');
      callback?.();
      return true;
    }) as typeof process.stdout.write);

    mockState.ensure
      .mockResolvedValueOnce(makeBackend(useCurrentRouting(), subscribe))
      .mockResolvedValueOnce(makeBackend(useCurrentRouting()))
      .mockResolvedValueOnce(makeBackend(useCurrentRouting()))
      .mockResolvedValueOnce(makeBackend({ kind: 'handoff', target, source: 'live-incumbent' }));

    const result = await launchAndFollow({
      launchResult: {
        kind: 'provider-session',
        launchState: 'running',
        jobId: 'job-1',
        sessionId: 'session-1',
      } satisfies AcceptedLaunchResponse,
      abortJob: vi.fn().mockResolvedValue(undefined),
      pluginRoot: '/plugin/root',
      projectRoot: '/project/root',
      emitError: (error: unknown) => {
        throw error;
      },
      isTTY: false,
      columns: 100,
    });

    expect(result).toBe(0);
    expect(readFileSync(tracePath, 'utf8')).toBe('old-one\nold-two\nnew-three\nnew-four\n');
    expect(stdout).toContain('handed off to 2.0.0; use that version from now on');
    expect(subscribe).toHaveBeenCalledOnce();
    expect(mockState.ensure).toHaveBeenCalledTimes(4);
  });
});
