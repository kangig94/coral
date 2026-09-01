import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from '#src/infra/build-flavor.js';
import { isNoEntryError } from '#src/infra/fs-errors.js';
import type { CoordinatorDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { storePaths } from '#src/infra/path/store.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const sourceBackendBundle = join(process.cwd(), 'clients', 'build', 'coral-backend.cjs');
const sourceCliBundle = join(process.cwd(), 'clients', 'build', 'coral-cli.cjs');
const sourceClaudeAppserverBundle = join(process.cwd(), 'clients', 'build', 'coral-claude-appserver.cjs');
const sourceManifestPath = join(process.cwd(), 'clients', 'build', 'manifest.json');
const requiredBuildArtifacts = [
  sourceBackendBundle,
  sourceCliBundle,
  sourceClaudeAppserverBundle,
  sourceManifestPath,
] as const;

type SourceManifest = {
  version: string;
  buildSetId: string;
  bundleHash: string;
  cliBundleHash: string;
  claudeAppserverBundleHash: string;
  flavor: BuildFlavor;
  storeFormatFingerprint: string;
};

function readSourceManifest(): SourceManifest {
  assertBuildArtifactsAvailable();
  return JSON.parse(readFileSync(sourceManifestPath, 'utf-8')) as SourceManifest;
}

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
  return requiredBuildArtifacts.every((path) => existsSync(path));
}

export function assertBuildArtifactsAvailable(): void {
  const missing = requiredBuildArtifacts.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Required clients/build artifacts are missing. Run npm run build first. Missing: ${missing.join(', ')}`,
    );
  }
}

export function createPluginFixture(
  tempRoots: string[],
  options: {
    flavor: BuildFlavor;
    bundleHash?: string;
    version?: string;
  },
): PluginFixture {
  const sourceManifest = readSourceManifest();
  const root = mkdtempSync(join(tmpdir(), `coral-coordinator-${options.flavor}-`));
  tempRoots.push(root);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  const backendPath = join(root, 'bridge', 'coral-backend.cjs');
  const cliPath = join(root, 'bridge', 'coral-cli.cjs');
  const claudeAppserverPath = join(root, 'bridge', 'coral-claude-appserver.cjs');
  const copyBundle = (source: string, destination: string): void => {
    if (options.version === undefined) {
      copyFileSync(source, destination);
      return;
    }
    writeFileSync(
      destination,
      readFileSync(source, 'utf-8').replaceAll(sourceManifest.version, options.version),
      'utf-8',
    );
  };
  copyBundle(sourceBackendBundle, backendPath);
  if (options.bundleHash !== undefined) {
    appendFileSync(backendPath, `\n// fixture ${options.bundleHash}\n`);
  }
  copyBundle(sourceCliBundle, cliPath);
  copyBundle(sourceClaudeAppserverBundle, claudeAppserverPath);
  const bundleHash = createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16);
  writeFileSync(
    join(root, 'bridge', 'manifest.json'),
    JSON.stringify({
      version: options.version ?? sourceManifest.version,
      buildSetId: sourceManifest.buildSetId,
      bundleHash,
      cliBundleHash: createHash('sha256').update(readFileSync(cliPath)).digest('hex').slice(0, 16),
      claudeAppserverBundleHash: createHash('sha256')
        .update(readFileSync(claudeAppserverPath))
        .digest('hex')
        .slice(0, 16),
      flavor: options.flavor,
      storeFormatFingerprint: sourceManifest.storeFormatFingerprint,
    }) + '\n',
    'utf-8',
  );

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    join(process.cwd(), 'node_modules', 'better-sqlite3'),
    join(root, 'node_modules', 'better-sqlite3'),
    'dir',
  );

  return {
    root,
    flavor: options.flavor,
    bundleHash,
  };
}

export function updatePluginFixtureBundleHash(fixture: PluginFixture, bundleHash: string): PluginFixture {
  const sourceManifest = readSourceManifest();
  const backendPath = join(fixture.root, 'bridge', 'coral-backend.cjs');
  appendFileSync(backendPath, `\n// fixture ${bundleHash}\n`);
  const effectiveBundleHash = createHash('sha256').update(readFileSync(backendPath)).digest('hex').slice(0, 16);
  writeFileSync(
    join(fixture.root, 'bridge', 'manifest.json'),
    `${JSON.stringify({
      version: sourceManifest.version,
      buildSetId: sourceManifest.buildSetId,
      bundleHash: effectiveBundleHash,
      cliBundleHash: sourceManifest.cliBundleHash,
      claudeAppserverBundleHash: sourceManifest.claudeAppserverBundleHash,
      flavor: fixture.flavor,
      storeFormatFingerprint: sourceManifest.storeFormatFingerprint,
    })}\n`,
    'utf-8',
  );
  return { ...fixture, bundleHash: effectiveBundleHash };
}

export function coordinatorFilesForHome(home: string, flavor: BuildFlavor) {
  return coordinatorPaths(flavor, { baseDir: join(home, '.coral') });
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
