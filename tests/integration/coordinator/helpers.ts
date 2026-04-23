import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from '#src/runtime/flavor.js';
import type { LockRecord } from '#src/infra/lock-record.js';
import { isNoEntryError } from '#src/infra/fs-errors.js';
import type { CoordinatorDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { coordinatorPaths } from '#src/infra/coordinator-paths.js';
import { storePaths } from '#src/store/paths.js';

const sourceBackendBundle = join(process.cwd(), 'build', 'coral-backend.cjs');
const sourceManifest = JSON.parse(readFileSync(join(process.cwd(), 'build', 'manifest.json'), 'utf-8')) as {
  bundleHash: string;
};

export type PluginFixture = {
  root: string;
  flavor: BuildFlavor;
  bundleHash: string;
};

export type SpawnedCoordinator = {
  child: ReturnType<typeof spawn>;
  fixture: PluginFixture;
  home: string;
  output(): string;
};

export function buildArtifactsAvailable(): boolean {
  return existsSync(sourceBackendBundle);
}

export function createPluginFixture(
  tempRoots: string[],
  options: {
    flavor: BuildFlavor;
    bundleHash?: string;
  },
): PluginFixture {
  const root = mkdtempSync(join(tmpdir(), `coral-coordinator-${options.flavor}-`));
  tempRoots.push(root);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  copyFileSync(sourceBackendBundle, join(root, 'bridge', 'coral-backend.cjs'));
  writeFileSync(
    join(root, 'bridge', 'manifest.json'),
    JSON.stringify({
      bundleHash: options.bundleHash ?? sourceManifest.bundleHash,
      flavor: options.flavor,
    }) + '\n',
    'utf-8',
  );

  cpSync(join(process.cwd(), 'dist', 'store', 'migrations'), join(root, 'dist', 'store', 'migrations'), {
    recursive: true,
  });

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(join(process.cwd(), 'node_modules', 'better-sqlite3'), join(root, 'node_modules', 'better-sqlite3'), 'dir');

  return {
    root,
    flavor: options.flavor,
    bundleHash: options.bundleHash ?? sourceManifest.bundleHash,
  };
}

export function coordinatorFilesForHome(home: string, flavor: BuildFlavor) {
  return coordinatorPaths(flavor, process.env, { baseDir: join(home, '.coral') });
}

export function storeDbPathForHome(home: string, flavor: BuildFlavor): string {
  return storePaths(flavor, { baseDir: join(home, '.coral') }).dbFile;
}

export function readDiscoveryRecordForHome(home: string, flavor: BuildFlavor): CoordinatorDiscoveryRecord | null {
  const infoPath = coordinatorFilesForHome(home, flavor).infoFile;
  try {
    return JSON.parse(readFileSync(infoPath, 'utf-8')) as CoordinatorDiscoveryRecord;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export function readLockRecordForHome(home: string, flavor: BuildFlavor): LockRecord | null {
  const lockPath = coordinatorFilesForHome(home, flavor).lockFile;
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as LockRecord;
  } catch (error: unknown) {
    if (isNoEntryError(error) || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function waitForCondition(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

export async function waitForDiscoveryRecord(
  home: string,
  flavor: BuildFlavor,
  timeoutMs = 10_000,
): Promise<CoordinatorDiscoveryRecord> {
  await waitForCondition(() => readDiscoveryRecordForHome(home, flavor) !== null, timeoutMs);
  const record = readDiscoveryRecordForHome(home, flavor);
  if (!record) {
    throw new Error(`Expected discovery record for ${flavor}`);
  }
  return record;
}

export function spawnCoordinator(options: {
  fixture: PluginFixture;
  home: string;
  tempRoots: string[];
  env?: Record<string, string>;
}): SpawnedCoordinator {
  const scratchCwd = mkdtempSync(join(tmpdir(), 'coral-coordinator-cwd-'));
  options.tempRoots.push(scratchCwd);

  const child = spawn('node', [join(options.fixture.root, 'bridge', 'coral-backend.cjs')], {
    cwd: scratchCwd,
    env: {
      ...process.env,
      HOME: options.home,
      TMPDIR: options.home,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  return {
    child,
    fixture: options.fixture,
    home: options.home,
    output: () => `${stdout}${stderr}`,
  };
}

export async function waitForProcessExit(
  handle: SpawnedCoordinator,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return {
      code: handle.child.exitCode,
      signal: handle.child.signalCode,
    };
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for coordinator exit.\n${handle.output()}`));
    }, timeoutMs);

    handle.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    handle.child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function stopCoordinator(handle: SpawnedCoordinator, timeoutMs = 10_000): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
    return;
  }

  handle.child.kill('SIGTERM');
  try {
    await waitForProcessExit(handle, timeoutMs);
  } catch {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill('SIGKILL');
      await waitForProcessExit(handle, 2_000).catch(() => {});
    }
  }
}
