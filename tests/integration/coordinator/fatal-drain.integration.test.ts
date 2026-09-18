import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';

import { readShutdownRemainderStatus, shutdownRemainderPath } from '#src/coordinator/shutdown-remainder.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import type { StrictBundleManifest } from '#src/infra/bundle-manifest.js';
import { observeProcessLiveness } from '#src/infra/node-process.js';
import { createRealRuntime } from '#src/runtime/real.js';
import {
  buildArtifactsAvailable,
  coordinatorFilesForHome,
  createPluginFixture,
  probeCoordinatorSocket,
  readDiscoveryRecordForHome,
  spawnCoordinator,
  stopCoordinator,
  waitForCoordinatorSocketRelease,
  waitForDiscoveryRecord,
  waitForProcessExit,
  type PluginFixture,
  type SpawnedCoordinator,
} from '#tests/integration/coordinator/helpers.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const tempRoots: string[] = [];
const coordinators: SpawnedCoordinator[] = [];
const FATAL_DRAIN_ACTIONS_FILE = 'fatal-drain-actions.log';
let successorPid: number | null = null;

function topLevelEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    CORAL_KB_ENABLE: '0',
    CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
  };
  delete environment.CORAL_CHILD;
  delete environment.CORAL_CHILD_PRINCIPAL_HANDLE;
  delete environment.CORAL_JOB_ID;
  delete environment.CORAL_SESSION_ID;
  delete environment.CORAL_CLI_HANDOFF_DELEGATED;
  delete environment.CORAL_BACKEND_DISABLE_AUTOSTART;
  return environment;
}

async function buildFatalDrainBackend(fixture: PluginFixture): Promise<string> {
  const bridgeDir = join(fixture.root, 'bridge');
  const manifest = JSON.parse(
    readFileSync(join(bridgeDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), 'utf-8'),
  ) as StrictBundleManifest;
  const bundleDir = join(fixture.root, 'fatal-drain-test-bundle');
  mkdirSync(bundleDir);

  for (const artifact of ['coral-cli.cjs', 'coral-claude-appserver.cjs', 'coral-durable-wrapper.cjs']) {
    copyFileSync(join(bridgeDir, artifact), join(bundleDir, artifact));
  }

  const backendPath = join(bundleDir, 'coral-backend.cjs');
  const embeddedIdentity = {
    version: manifest.version,
    buildSetId: manifest.buildSetId,
    flavor: manifest.flavor,
    storeFormatFingerprint: manifest.storeFormatFingerprint,
  };
  await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/fatal-drain-backend.ts', import.meta.url))],
    outfile: backendPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['node:*', '@lydell/node-pty'],
    loader: { '.sql': 'text' },
    minify: true,
    banner: {
      js:
        `var __CORAL_BUILD_IDENTITY__=${JSON.stringify(embeddedIdentity)};` +
        'var __PLUGIN_ROOT__=require("path").resolve(__dirname,"..");' +
        'var __BUNDLE_DIR__=__dirname;' +
        'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
    },
    define: {
      __VERSION__: JSON.stringify(manifest.version),
      __BUILD_SET_ID__: JSON.stringify(manifest.buildSetId),
      __BUILD_FLAVOR__: JSON.stringify(manifest.flavor),
      __STORE_FORMAT_FINGERPRINT__: JSON.stringify(manifest.storeFormatFingerprint),
      __IS_CORAL_BACKEND_MAIN__: 'false',
      'import.meta.url': '__importMetaUrl',
    },
  });

  const testManifest: StrictBundleManifest = {
    ...manifest,
    bundleHash: createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16),
  };
  writeFileSync(join(bundleDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE), `${JSON.stringify(testManifest)}\n`, 'utf-8');
  return backendPath;
}

async function runMutatingCommand(
  fixture: PluginFixture,
  home: string,
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}> {
  const child = spawn(process.execPath, [join(fixture.root, 'bridge', 'coral-cli.cjs'), 'abort', '--all'], {
    cwd: fixture.root,
    env: topLevelEnvironment(home),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    output += chunk;
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out waiting for mutating command.\n${output}`));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

afterEach(async () => {
  while (coordinators.length > 0) {
    const coordinator = coordinators.pop();
    if (coordinator) await stopCoordinator(coordinator);
  }

  if (successorPid !== null && observeProcessLiveness(successorPid) !== 'absent') {
    process.kill(successorPid, 'SIGTERM');
    await waitForCondition(() => observeProcessLiveness(successorPid!) === 'absent', 5_000).catch(() => {});
    if (observeProcessLiveness(successorPid) !== 'absent') process.kill(successorPid, 'SIGKILL');
  }
  successorPid = null;

  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('coordinator fatal drain integration', () => {
  it('records a clean-drain fatal, exits nonzero, and leaves the socket available to a fresh coordinator', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected clients/build artifacts to exist before running integration tests');
    }

    const home = mkdtempSync(join(tmpdir(), 'coral-fatal-drain-home-'));
    tempRoots.push(home);
    const fixture = createPluginFixture(tempRoots, { flavor: 'prod' });
    const fatalBackendPath = await buildFatalDrainBackend(fixture);
    const fatalCoordinator = spawnCoordinator({
      fixture,
      home,
      tempRoots,
      backendPath: fatalBackendPath,
      triggerPipe: true,
      env: {
        CORAL_KB_ENABLE: '0',
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(fatalCoordinator);

    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const files = coordinatorFilesForHome(home, 'prod');
    expect(await probeCoordinatorSocket(files.socketPath)).toBe('accepting');

    if (fatalCoordinator.triggerPipe === null) throw new Error('Expected a parent-owned fatal trigger pipe');
    fatalCoordinator.triggerPipe.end(Buffer.from([1]));
    let exit: Awaited<ReturnType<typeof waitForProcessExit>>;
    try {
      exit = await waitForProcessExit(fatalCoordinator, 10_000);
    } catch (error: unknown) {
      const discovery = readDiscoveryRecordForHome(home, 'prod');
      const socket = await probeCoordinatorSocket(files.socketPath).catch((probeError: unknown) =>
        probeError instanceof Error ? probeError.message : String(probeError),
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `discovery=${JSON.stringify(discovery)} socket=${JSON.stringify(socket)} ` +
          `exitCode=${String(fatalCoordinator.child.exitCode)} ` +
          `signalCode=${String(fatalCoordinator.child.signalCode)} ` +
          `liveness=${JSON.stringify(observeProcessLiveness(fatalCoordinator.child.pid ?? -1))}`,
        { cause: error },
      );
    }
    expect(exit.signal).toBeNull();
    expect(exit.code).not.toBeNull();
    expect(exit.code).not.toBe(0);
    expect(readDiscoveryRecordForHome(home, 'prod')).toBeNull();
    expect(await waitForCoordinatorSocketRelease(files.socketPath, 5_000)).toBe('unlinked');

    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const remainder = readShutdownRemainderStatus({ storage: runtime.storage, runDir: files.runDir });
    expect(existsSync(join(shutdownRemainderPath(files.runDir), `${initial.instanceId}.json`))).toBe(true);
    expect(remainder.kind).toBe('available');
    if (remainder.kind !== 'available') throw new Error(`Expected a shutdown remainder, got ${remainder.kind}`);
    expect(remainder.status.records.find(({ instanceId }) => instanceId === initial.instanceId)).toMatchObject({
      reason: 'provider-proxy-lifecycle-fatal',
      mode: 'handoff',
      entries: [
        {
          label: 'provider proxy lifecycle fatal incident',
          remainder: { owner: 'process-exit' },
          settlement: {
            cause: 'rejected',
            detail: expect.stringContaining('deterministic corrupt provider-proxy lifecycle evidence'),
          },
        },
      ],
    });

    const command = await runMutatingCommand(fixture, home);
    expect(command, command.output).toMatchObject({ code: 0, signal: null });
    const successor = await waitForDiscoveryRecord(home, 'prod', 15_000);
    successorPid = successor.pid;
    expect(successor.pid).not.toBe(initial.pid);
    expect(successor.instanceId).not.toBe(initial.instanceId);
    expect(successor.bundleHash).toBe(fixture.bundleHash);
    expect(await probeCoordinatorSocket(files.socketPath)).toBe('accepting');
  });

  it('promotes an in-flight hard drain to the fatal handoff without running hard consequences', async () => {
    if (!buildArtifactsAvailable()) {
      throw new Error('Expected clients/build artifacts to exist before running integration tests');
    }

    const home = mkdtempSync(join(tmpdir(), 'coral-fatal-during-hard-drain-home-'));
    tempRoots.push(home);
    const fixture = createPluginFixture(tempRoots, { flavor: 'prod' });
    const fatalBackendPath = await buildFatalDrainBackend(fixture);
    const fatalCoordinator = spawnCoordinator({
      fixture,
      home,
      tempRoots,
      backendPath: fatalBackendPath,
      triggerPipe: true,
      env: {
        CORAL_KB_ENABLE: '0',
        CORAL_BOOT_FRESHNESS_TIMEOUT_MS: '1000',
      },
    });
    coordinators.push(fatalCoordinator);

    const initial = await waitForDiscoveryRecord(home, 'prod', 15_000);
    const files = coordinatorFilesForHome(home, 'prod');
    if (fatalCoordinator.triggerPipe === null) throw new Error('Expected a parent-owned fatal trigger pipe');
    fatalCoordinator.triggerPipe.end(Buffer.from([2]));

    const exit = await waitForProcessExit(fatalCoordinator, 10_000);
    expect(exit).toMatchObject({ signal: null });
    expect(exit.code).not.toBeNull();
    expect(exit.code).not.toBe(0);
    expect(readDiscoveryRecordForHome(home, 'prod')).toBeNull();
    expect(await waitForCoordinatorSocketRelease(files.socketPath, 5_000)).toBe('unlinked');

    const actions = readFileSync(join(home, FATAL_DRAIN_ACTIONS_FILE), 'utf-8').trim().split('\n');
    expect(actions).toContain('provider-host-handoff-drain');
    expect(actions).not.toContain('provider-host-hard-shutdown');
    expect(actions).not.toContain('pending-launch-settlement');
    expect(actions).not.toContain('child-termination');
    expect(actions).not.toContain('job-terminalization');

    const runtime = createRealRuntime('prod', { baseDir: join(home, '.coral') });
    const remainder = readShutdownRemainderStatus({ storage: runtime.storage, runDir: files.runDir });
    expect(remainder.kind).toBe('available');
    if (remainder.kind !== 'available') throw new Error(`Expected a shutdown remainder, got ${remainder.kind}`);
    expect(remainder.status.records.find(({ instanceId }) => instanceId === initial.instanceId)).toMatchObject({
      reason: 'provider-proxy-lifecycle-fatal',
      mode: 'handoff',
      entries: [
        {
          label: 'provider proxy lifecycle fatal incident',
          settlement: {
            cause: 'rejected',
            detail: expect.stringContaining('deterministic corrupt provider-proxy lifecycle evidence'),
          },
        },
      ],
    });
  });
});
