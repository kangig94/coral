import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type BuildFlavor } from '#src/infra/build-flavor.js';
import { readBackendInfo, type BackendInfo } from '#src/infra/backend-discovery.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { readBuildFlavor } from '#src/infra/bundle-manifest.js';
import { CURRENT_STRICT_BUNDLE_MANIFEST_FILE } from '#src/infra/bundle-manifest-address.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { storePaths } from '#src/infra/path/store.js';
import { ensure } from '#src/transport/ipc/ensure.js';
import { createTemporaryHomeOwner, type TemporaryHome } from '#tests/support/temporary-home-lifecycle.js';
import { waitForCondition } from '#tests/support/wait-for-condition.js';

const sourceBuildDir = join(process.cwd(), 'clients', 'build');
const sourceBackendBundle = join(sourceBuildDir, 'coral-backend.cjs');
const sourceSupervisorBundle = join(sourceBuildDir, 'coral-sentinel.cjs');
const sourceCliBundle = join(sourceBuildDir, 'coral-cli');
const sourceClaudeAppserverBundle = join(sourceBuildDir, 'coral-claude-appserver.cjs');
const sourceDurableWrapperBundle = join(sourceBuildDir, 'coral-durable-wrapper.cjs');
const sourceManifestPath = join(sourceBuildDir, 'manifest.json');
const sourceStrictManifestPath = join(sourceBuildDir, CURRENT_STRICT_BUNDLE_MANIFEST_FILE);
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf-8')) as { flavor: BuildFlavor };

const tempRoots: string[] = [];
const temporaryHomes = createTemporaryHomeOwner();

afterEach(async () => {
  await temporaryHomes.cleanup();

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createPluginFixture(root: string): void {
  mkdirSync(join(root, 'bridge'), { recursive: true });
  copyFileSync(sourceBackendBundle, join(root, 'bridge', 'coral-backend.cjs'));
  copyFileSync(sourceSupervisorBundle, join(root, 'bridge', 'coral-sentinel.cjs'));
  copyFileSync(sourceCliBundle, join(root, 'bridge', 'coral-cli'));
  copyFileSync(sourceClaudeAppserverBundle, join(root, 'bridge', 'coral-claude-appserver.cjs'));
  copyFileSync(sourceDurableWrapperBundle, join(root, 'bridge', 'coral-durable-wrapper.cjs'));
  copyFileSync(sourceManifestPath, join(root, 'bridge', 'manifest.json'));
  copyFileSync(sourceStrictManifestPath, join(root, 'bridge', CURRENT_STRICT_BUNDLE_MANIFEST_FILE));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    join(process.cwd(), 'node_modules', 'better-sqlite3'),
    join(root, 'node_modules', 'better-sqlite3'),
    'dir',
  );
}

function createCoordinatorHome(sharedStoreDir: string): TemporaryHome {
  const home = temporaryHomes.create('coral-namespace-home-', sourceManifest.flavor);
  const store = storePaths(sourceManifest.flavor, { baseDir: join(home, '.coral') });
  mkdirSync(dirname(store.dbDir), { recursive: true });
  symlinkSync(sharedStoreDir, store.dbDir, 'dir');
  return home;
}

async function requireBackendInfo(home: TemporaryHome): Promise<BackendInfo> {
  const discoveryRuntime = temporaryHomes.discoveryRuntime(home);
  await waitForCondition(() => readBackendInfo(discoveryRuntime) !== null);
  const info = readBackendInfo(discoveryRuntime);
  if (!info) {
    throw new Error(`Expected backend info for ${home}`);
  }
  return info;
}

const childIdentityEnvKeys = [
  'CORAL_CHILD',
  'CORAL_CHILD_PRINCIPAL_HANDLE',
  'CORAL_JOB_ID',
  'CORAL_SESSION_ID',
] as const;

async function withTopLevelHome<T>(home: TemporaryHome, action: () => Promise<T>): Promise<T> {
  const previousChildIdentity = childIdentityEnvKeys.map((key) => [key, process.env[key]] as const);
  for (const key of childIdentityEnvKeys) {
    delete process.env[key];
  }
  try {
    return await temporaryHomes.withHome(home, action);
  } finally {
    for (const [key, value] of previousChildIdentity) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function ensureFixtureBackend(pluginRoot: string, home: TemporaryHome): Promise<void> {
  await withTopLevelHome(home, async () => {
    try {
      await ensure('sessions.create', pluginRoot);
    } catch (error: unknown) {
      const flavor = readBuildFlavor(pluginRoot);
      const paths = coordinatorPaths(flavor, { baseDir: join(home, '.coral') });
      const diagnostics = [join(paths.runDir, 'coordinator.log'), paths.startupErrorFile, paths.startupDiagnosticFile]
        .filter((path) => existsSync(path))
        .map((path) => `${path}:\n${readFileSync(path, 'utf-8')}`)
        .join('\n');
      throw new Error(`Failed to start ${flavor} fixture backend.\n${diagnostics}`, { cause: error });
    }
  });
}

describe('namespace coexistence integration', () => {
  it('runs distinct bundle namespaces side by side over a shared store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-namespace-'));
    tempRoots.push(root);
    const sharedStoreDir = join(root, 'store');
    mkdirSync(sharedStoreDir);
    const firstHome = createCoordinatorHome(sharedStoreDir);
    const secondHome = createCoordinatorHome(sharedStoreDir);
    const firstFixture = join(root, 'first');
    const secondFixture = join(root, 'second');
    createPluginFixture(firstFixture);
    createPluginFixture(secondFixture);

    await ensureFixtureBackend(firstFixture, firstHome);
    await ensureFixtureBackend(secondFixture, secondHome);

    const firstInfo = await requireBackendInfo(firstHome);
    const secondInfo = await requireBackendInfo(secondHome);
    expect(firstInfo.namespace).toBe(pluginRootNamespace(firstFixture));
    expect(secondInfo.namespace).toBe(pluginRootNamespace(secondFixture));
    expect(firstInfo.namespace).not.toBe(secondInfo.namespace);
    expect(firstInfo.pid).not.toBe(secondInfo.pid);
  });
});
