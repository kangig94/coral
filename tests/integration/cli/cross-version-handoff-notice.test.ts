import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHandoffNotice } from '#src/cli/handoff-notice.js';
import { runHandoff, type HandoffOutcome } from '#src/coordinator/handoff-runner.js';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import type * as BundleManifestMod from '#src/infra/bundle-manifest.js';

type StrictBundleManifest = BundleManifestMod.StrictBundleManifest;

const mockState = vi.hoisted(() => ({
  createIpcClient: vi.fn(),
  createRealRuntime: vi.fn(),
  health: vi.fn(),
  probeCoordinator: vi.fn(),
  readBuildFlavor: vi.fn(),
  resolveStrictBundleIdentity: vi.fn(),
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function createTarget(tracePath: string, exitCode: number): { bundleDir: string; manifest: StrictBundleManifest } {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-notice-'));
  const bundleDir = join(fixtureRoot, 'bundle');
  fixtureRoots.push(fixtureRoot);
  mkdirSync(bundleDir);

  const cliBundle = [
    "const { appendFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(tracePath)}, 'delegated operation finished\\n');`,
    `process.exit(${exitCode});`,
  ].join('\n');
  const backendBundle = 'handoff notice backend fixture';
  const claudeAppserverBundle = 'handoff notice claude appserver fixture';
  const manifest: StrictBundleManifest = {
    version: '2.3.4',
    buildSetId: '223e4567-e89b-42d3-a456-426614174000',
    bundleHash: sha256(backendBundle),
    cliBundleHash: sha256(cliBundle),
    claudeAppserverBundleHash: sha256(claudeAppserverBundle),
    flavor: 'prod',
    storeFormatFingerprint: `sha256:${'a'.repeat(64)}`,
  };

  writeFileSync(join(bundleDir, 'coral-backend.cjs'), backendBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-cli.cjs'), cliBundle, 'utf8');
  writeFileSync(join(bundleDir, 'coral-claude-appserver.cjs'), claudeAppserverBundle, 'utf8');
  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return { bundleDir, manifest };
}

async function runDelegatedOperation(tracePath: string, exitCode: number): Promise<HandoffOutcome> {
  const target = createTarget(tracePath, exitCode);
  const socketPath = join(tmpdir(), 'coral-handoff-notice.sock');
  mockState.probeCoordinator.mockReturnValue({
    socketPath,
    pid: 4242,
    bundleHash: target.manifest.bundleHash,
    flavor: 'prod',
    namespace: 'handoff-notice',
    bootToken: 'boot-token',
  });
  mockState.health.mockResolvedValue({
    status: 'ok',
    version: target.manifest.version,
    bundleHash: target.manifest.bundleHash,
    flavor: 'prod',
    namespace: 'handoff-notice',
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
      // The drain arms a real timer through the port, so the double must actually schedule.
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (handle: { unref?(): void } | null) => {
        clearTimeout(handle as unknown as NodeJS.Timeout);
      },
    },
    env: { cwd: () => process.cwd(), fullSnapshot: () => ({}) },
    paths: { coral: { coordinator: { socketPath } } },
  });

  const result = await runHandoff(
    { kind: 'cli-invocation', argv: ['node', 'coral-cli'] },
    { pluginRoot: '/plugin/root' },
  );
  if (result.kind !== 'delegated') {
    throw new Error('Expected the operation to run in the newer build.');
  }
  return result.outcome;
}

afterEach(() => {
  mockState.createIpcClient.mockReset();
  mockState.createRealRuntime.mockReset();
  mockState.health.mockReset();
  mockState.probeCoordinator.mockReset();
  mockState.readBuildFlavor.mockReset();
  mockState.resolveStrictBundleIdentity.mockReset();
  vi.restoreAllMocks();
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('cross-version-handoff-notice', () => {
  it('should render once on stderr after a delegated operation succeeds, leaving stdout intact', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-notice-trace-'));
    const tracePath = join(traceRoot, 'trace.txt');
    fixtureRoots.push(traceRoot);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk) => {
      const text = chunk.toString();
      stderr += text;
      appendFileSync(tracePath, text);
      return true;
    }) as typeof process.stderr.write);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      callback?.();
      return chunk.toString().length === 0;
    }) as typeof process.stdout.write);

    const outcome = await runDelegatedOperation(tracePath, 0);
    if (outcome.kind !== 'handoff-success') {
      throw new Error(`Expected handoff success, received ${outcome.kind}`);
    }
    renderHandoffNotice(outcome);
    renderHandoffNotice(outcome);

    const notice = 'handed off to 2.3.4; use that version from now on\n';
    expect(stderr).toBe(notice);
    expect(process.stderr.write).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledOnce();
    expect(stdoutWrite).toHaveBeenCalledWith('', expect.any(Function));
    expect(readFileSync(tracePath, 'utf8')).toBe(`delegated operation finished\n${notice}`);
  });

  it('should attach no notice or guidance to a delegated operation failure', async () => {
    const traceRoot = mkdtempSync(join(tmpdir(), 'coral-handoff-notice-trace-'));
    const tracePath = join(traceRoot, 'trace.txt');
    fixtureRoots.push(traceRoot);
    let written = '';
    const capture = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      written += chunk.toString();
      callback?.();
      return true;
    }) as typeof process.stdout.write;
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);

    const outcome = await runDelegatedOperation(tracePath, 23);

    expect(outcome).toEqual({ kind: 'handoff-exit', exitCode: 23 });
    expect(written).toBe('');
    expect(readFileSync(tracePath, 'utf8')).toBe('delegated operation finished\n');
  });
});
