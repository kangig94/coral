import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { launchAndFollow } from '#src/cli/follow.js';
import type { AcceptedLaunchResponse } from '#src/jobs/launch.js';
import type { WaitStreamEvent } from '#src/jobs/wait.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';

type StrictBundleManifest = BundleManifestMod.StrictBundleManifest;

const mockState = vi.hoisted(() => ({
  createIpcClient: vi.fn(),
  createRealRuntime: vi.fn(),
  ensure: vi.fn(),
  health: vi.fn(),
  probeCoordinator: vi.fn(),
  readBuildFlavor: vi.fn(),
  resolveStrictBundleIdentity: vi.fn(),
}));

vi.mock('#src/transport/ipc/ensure.js', () => ({
  ensure: mockState.ensure,
}));

vi.mock('#src/infra/backend-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BackendDiscoveryMod>();
  return { ...actual, probeCoordinator: mockState.probeCoordinator };
});

vi.mock('#src/infra/bundle-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof BundleManifestMod>();
  return {
    ...actual,
    readBuildFlavor: mockState.readBuildFlavor,
    resolveStrictBundleIdentity: mockState.resolveStrictBundleIdentity,
  };
});

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: mockState.createRealRuntime,
}));

vi.mock('#src/transport/ipc/client.js', () => ({
  createIpcClient: mockState.createIpcClient,
}));

const fixtureRoots: string[] = [];
const waitTiming = {
  origin: 'runtime',
  originAt: '2026-08-04T08:00:00.000Z',
  emittedAt: '2026-08-04T08:00:01.000Z',
  elapsedMs: 1_000,
} as const;

function bundleHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function createReplayBundle(tracePath: string): {
  readonly bundleDir: string;
  readonly manifest: StrictBundleManifest;
} {
  const root = mkdtempSync(join(tmpdir(), 'coral-cross-version-follow-'));
  const bundleDir = join(root, 'bundle');
  fixtureRoots.push(root);
  mkdirSync(bundleDir);

  const cliBundle = [
    "const { appendFileSync } = require('node:fs');",
    `const tracePath = ${JSON.stringify(tracePath)};`,
    "const cursorIndex = process.argv.indexOf('--cursor');",
    "const cursor = JSON.parse(Buffer.from(process.argv[cursorIndex + 1], 'base64url').toString('utf8'));",
    "for (const event of [{ seq: 1, line: 'old-one' }, { seq: 2, line: 'old-two' }, { seq: 3, line: 'new-three' }, { seq: 4, line: 'new-four' }]) {",
    '  if (event.seq <= cursor.afterSeq) continue;',
    '  appendFileSync(tracePath, `${event.line}\n`);',
    '  process.stdout.write(`${event.line}\n`);',
    '}',
  ].join('\n');
  const backendBundle = 'cross-version follow backend fixture';
  const appserverBundle = 'cross-version follow appserver fixture';
  const manifest: StrictBundleManifest = {
    version: '2.0.0',
    buildSetId: '223e4567-e89b-42d3-a456-426614174000',
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
  return { bundleDir, manifest };
}

function makeBackend(subscribe = vi.fn()) {
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
    routing: { kind: 'use-current' } as const,
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
  mockState.createIpcClient.mockReset();
  mockState.createRealRuntime.mockReset();
  mockState.ensure.mockReset();
  mockState.health.mockReset();
  mockState.probeCoordinator.mockReset();
  mockState.readBuildFlavor.mockReset();
  mockState.resolveStrictBundleIdentity.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-version follow', () => {
  it('should replay journal output across a real handoff using afterSeq without duplicated or dropped lines', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'coral-cross-version-follow-trace-'));
    const tracePath = join(traceRoot, 'trace.txt');
    fixtureRoots.push(traceRoot);
    const target = createReplayBundle(tracePath);
    const socketPath = join(tmpdir(), 'coral-cross-version-follow.sock');
    const events: WaitStreamEvent[] = [
      { type: 'progress', jobId: 'job-1', seq: 1, message: 'old-one', timing: waitTiming },
      { type: 'progress', jobId: 'job-1', seq: 2, message: 'old-two', timing: waitTiming },
      { type: 'waiting', waitingJobIds: ['job-1'] },
    ];
    const subscribe = vi.fn().mockResolvedValue(makeSubscription(events));
    let stderr = '';

    vi.stubEnv('CORAL_CHILD', '');
    vi.stubEnv('CORAL_CHILD_PRINCIPAL_HANDLE', '');
    vi.stubEnv('CORAL_JOB_ID', '');
    vi.stubEnv('CORAL_SESSION_ID', '');
    vi.stubEnv('CORAL_CLI_HANDOFF_DELEGATED', '0');
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      const text = chunk.toString();
      if (text.includes('old-one')) appendFileSync(tracePath, 'old-one\n');
      if (text.includes('old-two')) appendFileSync(tracePath, 'old-two\n');
      callback?.();
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);

    mockState.ensure.mockResolvedValueOnce(makeBackend(subscribe)).mockResolvedValueOnce(makeBackend());
    mockState.probeCoordinator.mockReturnValueOnce(null).mockReturnValue({
      socketPath,
      pid: 4242,
      bundleHash: target.manifest.bundleHash,
      flavor: 'prod',
      namespace: 'cross-version-follow',
      bootToken: 'boot-token',
    });
    mockState.health.mockResolvedValue({
      status: 'ok',
      version: target.manifest.version,
      bundleHash: target.manifest.bundleHash,
      flavor: 'prod',
      namespace: 'cross-version-follow',
      instanceId: 'incumbent-1',
      pid: 4242,
      manifest: target.manifest,
      bundleDir: target.bundleDir,
    });
    mockState.createIpcClient.mockReturnValue({ health: mockState.health });
    mockState.readBuildFlavor.mockReturnValue('prod');
    mockState.resolveStrictBundleIdentity.mockReturnValue({
      ok: true,
      manifest: {
        ...target.manifest,
        version: '1.0.0',
        buildSetId: '123e4567-e89b-42d3-a456-426614174000',
      },
    });
    mockState.createRealRuntime.mockReturnValue({
      storage: {},
      time: {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: { unref?(): void } | null) => {
          clearTimeout(handle as unknown as NodeJS.Timeout);
        },
      },
      env: { cwd: () => process.cwd(), fullSnapshot: () => ({ ...process.env }) },
      paths: { coral: { coordinator: { socketPath } } },
    });

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
    expect(stderr).toBe(
      'handed off to 2.0.0; this repeats on every run until the installed plugin is upgraded to 2.0.0 or newer\n',
    );
    expect(subscribe).toHaveBeenCalledOnce();
    expect(mockState.ensure).toHaveBeenCalledTimes(2);
  });
});
