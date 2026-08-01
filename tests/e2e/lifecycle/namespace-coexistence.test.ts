import { currentCoralStoreFormat } from '#src/store-format.js';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildFlavor } from '#src/infra/build-flavor.js';
import type { BackendHealth } from '#src/transport/http/backend/health.js';
import { readBackendInfo, type BackendInfo } from '#src/infra/backend-discovery.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { readBuildFlavor } from '#src/infra/bundle-manifest.js';
import { jobsDir } from '#src/jobs/paths.js';
import { pluginRootNamespace } from '#src/infra/plugin-identity.js';
import { isProcessAlive } from '#src/infra/node-process.js';
import type { JobStatus } from '#src/jobs/records.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { openStoreDatabase } from '#src/store/db.js';
import { storePaths } from '#src/infra/path/store.js';
import { composeReducers } from '#src/store/reducers.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { ensure } from '#src/transport/ipc/ensure.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const sourceBuildDir = join(process.cwd(), 'clients', 'build');
const sourceBackendBundle = join(sourceBuildDir, 'coral-backend.cjs');
const sourceCliBundle = join(sourceBuildDir, 'coral-cli.cjs');
const sourceClaudeAppserverBundle = join(sourceBuildDir, 'coral-claude-appserver.cjs');
const sourceManifestPath = join(sourceBuildDir, 'manifest.json');
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf-8')) as {
  bundleHash: string;
  flavor: BuildFlavor;
};

const tempRoots: string[] = [];
const startedCoordinators: Array<{ pluginRoot: string; home: string }> = [];
const createdJobIds: string[] = [];

afterEach(async () => {
  for (const coordinator of startedCoordinators.splice(0).reverse()) {
    await stopBackend(coordinator.pluginRoot, coordinator.home);
  }

  for (const jobId of createdJobIds.splice(0)) {
    rmSync(join(jobsDir(createRealRuntime('prod').env), jobId), { recursive: true, force: true });
  }

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(50);
  }
  throw new Error('Timed out waiting for condition');
}

function createPluginFixture(): {
  root: string;
  bundleHash: string;
  flavor: BuildFlavor;
} {
  const root = mkdtempSync(join(tmpdir(), `coral-namespace-${sourceManifest.flavor}-`));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  copyFileSync(sourceBackendBundle, join(root, 'bridge', 'coral-backend.cjs'));
  copyFileSync(sourceCliBundle, join(root, 'bridge', 'coral-cli.cjs'));
  copyFileSync(sourceClaudeAppserverBundle, join(root, 'bridge', 'coral-claude-appserver.cjs'));
  copyFileSync(sourceManifestPath, join(root, 'bridge', 'manifest.json'));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    join(process.cwd(), 'node_modules', 'better-sqlite3'),
    join(root, 'node_modules', 'better-sqlite3'),
    'dir',
  );

  const scratchCwd = mkdtempSync(join(tmpdir(), `coral-fixture-smoke-${sourceManifest.flavor}-`));
  tempRoots.push(scratchCwd);
  const smokeDbPath = join(scratchCwd, 'fixture.db');
  const smokeRuntime = createRealRuntime(sourceManifest.flavor);
  openStoreDatabase({
    path: smokeDbPath,
    storage: smokeRuntime.storage,
    storeFormat: currentCoralStoreFormat(),
  }).close();
  const smokeOut = execFileSync(
    'node',
    [join(root, 'bridge', 'coral-backend.cjs'), '--smoke-open-store', '--path', smokeDbPath],
    {
      cwd: scratchCwd,
      encoding: 'utf-8',
    },
  );
  if (smokeOut.trim() !== 'ok') {
    throw new Error(`fixture smoke failed for ${root}: ${smokeOut}`);
  }

  return { root, bundleHash: sourceManifest.bundleHash, flavor: sourceManifest.flavor };
}

function createCoordinatorHome(sharedStoreDir: string): string {
  const home = mkdtempSync(join(tmpdir(), 'coral-namespace-home-'));
  tempRoots.push(home);
  const store = storePaths(sourceManifest.flavor, { baseDir: join(home, '.coral') });
  mkdirSync(dirname(store.dbDir), { recursive: true });
  symlinkSync(sharedStoreDir, store.dbDir, 'dir');
  return home;
}

function seedCompletedJobs(
  storePath: string,
  bundleHash: string,
  jobs: ReadonlyArray<{ jobId: string; namespace: string; projectRoot: string }>,
): void {
  createdJobIds.push(...jobs.map(({ jobId }) => jobId));
  for (const { projectRoot } of jobs) {
    mkdirSync(projectRoot, { recursive: true });
  }
  const runtime = createRealRuntime(sourceManifest.flavor);
  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePath,
    storage: runtime.storage,
  });

  try {
    for (const { jobId, namespace, projectRoot } of jobs) {
      const createdAt = new Date().toISOString();
      const sessionId = `${jobId}-session`;
      commitInputs(
        db,
        [
          {
            type: 'job.launch.requested',
            stream: { kind: 'job', id: jobId },
            namespace,
            project: projectRoot,
            refs: { jobId, sessionId },
            body: {
              owner: { kind: 'provider-session', id: sessionId },
              sessionId,
              provider: 'codex',
              projectRoot,
              backendNamespace: namespace,
              bundleHash,
              jobKind: 'provider',
              pool: 'default',
              enqueueSequence: 0,
              providerAction: 'exec',
              request: {
                prompt: 'seeded completed job',
                cwd: projectRoot,
                bypassPermissions: false,
                coralEnv: {},
              },
              createdAt,
            },
          },
          {
            type: 'job.terminal.recorded',
            stream: { kind: 'job', id: jobId },
            namespace,
            project: projectRoot,
            refs: { jobId, sessionId },
            body: {
              terminal: {
                outcome: { kind: 'completed' },
                durationMs: 0,
                content: `${jobId}-done`,
              },
            },
          },
        ],
        {
          now: () => new Date(),
          reducers: composeReducers(jobsRegistry),
          bodyCodec: createEventBodyCodec(),
          providers: permissiveProviderLookupPort,
        },
      );
    }
  } finally {
    db.close();
  }
}

function backendDiscoveryRuntime(pluginRoot: string, home: string) {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot), { baseDir: join(home, '.coral') });
  return { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
}

async function requireBackendInfo(pluginRoot: string, home: string): Promise<BackendInfo> {
  const discoveryRuntime = backendDiscoveryRuntime(pluginRoot, home);
  await waitForCondition(() => readBackendInfo(discoveryRuntime) !== null);
  const info = readBackendInfo(discoveryRuntime);
  if (!info) {
    throw new Error(`Expected backend info for ${pluginRoot}`);
  }
  return info;
}

async function withHome<T>(home: string, action: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return await action();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}

async function ensureFixtureBackend(pluginRoot: string, home: string): Promise<void> {
  await withHome(home, async () => {
    try {
      await ensure(pluginRoot);
    } catch (error: unknown) {
      const flavor = readBuildFlavor(pluginRoot);
      const paths = coordinatorPaths(flavor, process.env, { baseDir: join(home, '.coral') });
      const diagnostics = [join(paths.runDir, 'coordinator.log'), paths.startupErrorFile, paths.startupDiagnosticFile]
        .filter((path) => existsSync(path))
        .map((path) => `${path}:\n${readFileSync(path, 'utf-8')}`)
        .join('\n');
      throw new Error(`Failed to start ${flavor} fixture backend.\n${diagnostics}`, { cause: error });
    }
  });
}

async function fetchJson<T>(info: BackendInfo, path: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(`http://${info.host}:${info.port}${path}`, {
    headers: { 'X-Coral-Backend-Token': info.token },
  });
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as T;
}

async function stopBackend(pluginRoot: string, home: string): Promise<void> {
  const info = readBackendInfo(backendDiscoveryRuntime(pluginRoot, home));
  if (!info || !isProcessAlive(info.pid)) {
    return;
  }

  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
    return;
  }

  try {
    await waitForCondition(() => !isProcessAlive(info.pid), 10_000);
  } catch {
    try {
      process.kill(info.pid, 'SIGKILL');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error;
      }
    }
    await waitForCondition(() => !isProcessAlive(info.pid), 2_000).catch(() => {});
  }
}

describe('namespace coexistence integration', () => {
  it('runs same-flavor coordinators side-by-side with namespace-isolated job visibility', async () => {
    const sharedStoreDir = mkdtempSync(join(tmpdir(), 'coral-namespace-store-'));
    tempRoots.push(sharedStoreDir);
    const firstHome = createCoordinatorHome(sharedStoreDir);
    const secondHome = createCoordinatorHome(sharedStoreDir);
    const firstFixture = createPluginFixture();
    const secondFixture = createPluginFixture();

    const firstNamespace = pluginRootNamespace(firstFixture.root);
    const secondNamespace = pluginRootNamespace(secondFixture.root);
    expect(firstNamespace).not.toBe(secondNamespace);

    const firstJobId = `coexist-first-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const secondJobId = `coexist-second-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const projectRoot = join(firstHome, 'shared-project');
    const sharedStorePath = storePaths(sourceManifest.flavor, { baseDir: join(firstHome, '.coral') }).dbFile;
    seedCompletedJobs(sharedStorePath, sourceManifest.bundleHash, [
      { jobId: firstJobId, namespace: firstNamespace, projectRoot },
      { jobId: secondJobId, namespace: secondNamespace, projectRoot },
    ]);

    startedCoordinators.push(
      { pluginRoot: firstFixture.root, home: firstHome },
      { pluginRoot: secondFixture.root, home: secondHome },
    );
    await ensureFixtureBackend(firstFixture.root, firstHome);
    await ensureFixtureBackend(secondFixture.root, secondHome);

    const firstInfo = await requireBackendInfo(firstFixture.root, firstHome);
    const secondInfo = await requireBackendInfo(secondFixture.root, secondHome);

    expect(firstInfo.flavor).toBe(sourceManifest.flavor);
    expect(secondInfo.flavor).toBe(sourceManifest.flavor);
    expect(firstInfo.bundleHash).toBe(sourceManifest.bundleHash);
    expect(secondInfo.bundleHash).toBe(sourceManifest.bundleHash);
    expect(firstInfo.namespace).toBe(firstNamespace);
    expect(secondInfo.namespace).toBe(secondNamespace);
    expect(firstInfo.pid).not.toBe(process.pid);
    expect(secondInfo.pid).not.toBe(process.pid);
    expect(firstInfo.pid).not.toBe(secondInfo.pid);
    expect(firstInfo.port).not.toBe(secondInfo.port);

    const firstHealth = await fetchJson<BackendHealth>(firstInfo, '/health');
    const secondHealth = await fetchJson<BackendHealth>(secondInfo, '/health');
    expect(firstHealth.flavor).toBe(sourceManifest.flavor);
    expect(secondHealth.flavor).toBe(sourceManifest.flavor);
    expect(firstHealth.namespace).toBe(firstNamespace);
    expect(secondHealth.namespace).toBe(secondNamespace);
    expect(firstHealth.instanceId).toBe(firstInfo.instanceId);
    expect(secondHealth.instanceId).toBe(secondInfo.instanceId);

    const firstJobs = await fetchJson<{ jobs: Array<{ jobId: string; status: JobStatus }> }>(
      firstInfo,
      `/jobs?all=1&projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    const secondJobs = await fetchJson<{ jobs: Array<{ jobId: string; status: JobStatus }> }>(
      secondInfo,
      `/jobs?all=1&projectRoot=${encodeURIComponent(projectRoot)}`,
    );

    expect(firstJobs.jobs.map((job) => job.jobId)).toEqual([firstJobId]);
    expect(secondJobs.jobs.map((job) => job.jobId)).toEqual([secondJobId]);
    expect(firstJobs.jobs[0]?.status.backendNamespace).toBe(firstNamespace);
    expect(secondJobs.jobs[0]?.status.backendNamespace).toBe(secondNamespace);

    await fetchJson<{ status: JobStatus; events: unknown[] }>(
      firstInfo,
      `/jobs/${firstJobId}?projectRoot=${encodeURIComponent(projectRoot)}`,
    );
    await fetchJson<{ status: JobStatus; events: unknown[] }>(
      secondInfo,
      `/jobs/${secondJobId}?projectRoot=${encodeURIComponent(projectRoot)}`,
    );

    const firstForeignLookup = await fetchJson<{ code: string; message: string }>(
      firstInfo,
      `/jobs/${secondJobId}?projectRoot=${encodeURIComponent(projectRoot)}`,
      404,
    );
    const secondForeignLookup = await fetchJson<{ code: string; message: string }>(
      secondInfo,
      `/jobs/${firstJobId}?projectRoot=${encodeURIComponent(projectRoot)}`,
      404,
    );

    expect(firstForeignLookup.code).toBe('job_not_found');
    expect(secondForeignLookup.code).toBe('job_not_found');
  });
});
