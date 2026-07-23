import { currentCoralStoreFormat } from '#src/store-format.js';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

const sourceBackendBundle = join(process.cwd(), 'clients', 'build', 'coral-backend.cjs');
const sourceManifest = JSON.parse(readFileSync(join(process.cwd(), 'clients', 'build', 'manifest.json'), 'utf-8')) as {
  bundleHash: string;
  storeFormatFingerprint: string;
};
const sourcePackage = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };

const tempRoots: string[] = [];
const startedPluginRoots: string[] = [];
const createdJobIds: string[] = [];
let previousHome: string | undefined;

afterEach(async () => {
  for (const pluginRoot of startedPluginRoots.splice(0).reverse()) {
    await stopBackend(pluginRoot);
  }

  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  previousHome = undefined;

  for (const jobId of createdJobIds.splice(0)) {
    rmSync(join(jobsDir(createRealRuntime('prod').env), jobId), { recursive: true, force: true });
  }

  for (const root of tempRoots.splice(0)) {
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

function createPluginFixture(flavor: 'prod' | 'dev'): {
  root: string;
  bundleHash: string;
  manifestFlavor: 'prod' | 'dev';
} {
  const root = mkdtempSync(join(tmpdir(), `coral-flavor-${flavor}-`));
  tempRoots.push(root);
  mkdirSync(join(root, 'bridge'), { recursive: true });
  copyFileSync(sourceBackendBundle, join(root, 'bridge', 'coral-backend.cjs'));
  writeFileSync(
    join(root, 'bridge', 'manifest.json'),
    JSON.stringify({
      bundleHash: sourceManifest.bundleHash,
      flavor,
      storeFormatFingerprint: sourceManifest.storeFormatFingerprint,
    }) + '\n',
    'utf-8',
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: sourcePackage.version }) + '\n', 'utf-8');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(
    join(process.cwd(), 'node_modules', 'better-sqlite3'),
    join(root, 'node_modules', 'better-sqlite3'),
    'dir',
  );

  const scratchCwd = mkdtempSync(join(tmpdir(), `coral-fixture-smoke-${flavor}-`));
  tempRoots.push(scratchCwd);
  const smokeDbPath = join(root, 'fixture.db');
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

  return { root, bundleHash: sourceManifest.bundleHash, manifestFlavor: flavor };
}

function seedCompletedJob(
  jobId: string,
  namespace: string,
  projectRoot: string,
  bundleHash: string,
  flavor: 'prod' | 'dev',
): void {
  createdJobIds.push(jobId);
  mkdirSync(projectRoot, { recursive: true });
  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePaths(flavor).dbFile,
    storage: runtime.storage,
  });
  const createdAt = new Date().toISOString();
  const sessionId = `${jobId}-session`;

  try {
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
  } finally {
    db.close();
  }
}

function backendDiscoveryRuntime(pluginRoot: string) {
  const runtime = createRealRuntime(readBuildFlavor(pluginRoot));
  return { storage: runtime.storage, env: runtime.env, paths: runtime.paths };
}

async function requireBackendInfo(pluginRoot: string): Promise<BackendInfo> {
  const discoveryRuntime = backendDiscoveryRuntime(pluginRoot);
  await waitForCondition(() => readBackendInfo(discoveryRuntime) !== null);
  const info = readBackendInfo(discoveryRuntime);
  if (!info) {
    throw new Error(`Expected backend info for ${pluginRoot}`);
  }
  return info;
}

async function ensureFixtureBackend(pluginRoot: string): Promise<void> {
  try {
    await ensure(pluginRoot);
  } catch (error: unknown) {
    const flavor = readBuildFlavor(pluginRoot);
    const paths = coordinatorPaths(flavor);
    const diagnostics = [join(paths.runDir, 'coordinator.log'), paths.startupErrorFile, paths.startupDiagnosticFile]
      .filter((path) => existsSync(path))
      .map((path) => `${path}:\n${readFileSync(path, 'utf-8')}`)
      .join('\n');
    throw new Error(`Failed to start ${flavor} fixture backend.\n${diagnostics}`, { cause: error });
  }
}

async function fetchJson<T>(info: BackendInfo, path: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(`http://${info.host}:${info.port}${path}`, {
    headers: { 'X-Coral-Backend-Token': info.token },
  });
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as T;
}

async function stopBackend(pluginRoot: string): Promise<void> {
  const info = readBackendInfo(backendDiscoveryRuntime(pluginRoot));
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

describe('flavor coexistence integration', () => {
  it('runs prod and dev child backends side-by-side with isolated job visibility', async () => {
    previousHome = process.env.HOME;
    const tempHome = mkdtempSync(join(tmpdir(), 'coral-flavor-home-'));
    tempRoots.push(tempHome);
    process.env.HOME = tempHome;

    const prodFixture = createPluginFixture('prod');
    const devFixture = createPluginFixture('dev');

    expect(existsSync(join(prodFixture.root, 'bridge', 'coral-backend.cjs'))).toBe(true);
    expect(existsSync(join(devFixture.root, 'bridge', 'coral-backend.cjs'))).toBe(true);

    const prodManifest = JSON.parse(readFileSync(join(prodFixture.root, 'bridge', 'manifest.json'), 'utf-8')) as {
      bundleHash: string;
      flavor: 'prod' | 'dev';
      storeFormatFingerprint: string;
    };
    const devManifest = JSON.parse(readFileSync(join(devFixture.root, 'bridge', 'manifest.json'), 'utf-8')) as {
      bundleHash: string;
      flavor: 'prod' | 'dev';
      storeFormatFingerprint: string;
    };

    expect(prodManifest).toEqual({
      bundleHash: sourceManifest.bundleHash,
      flavor: 'prod',
      storeFormatFingerprint: sourceManifest.storeFormatFingerprint,
    });
    expect(devManifest).toEqual({
      bundleHash: sourceManifest.bundleHash,
      flavor: 'dev',
      storeFormatFingerprint: sourceManifest.storeFormatFingerprint,
    });

    const prodNamespace = pluginRootNamespace(prodFixture.root);
    const devNamespace = pluginRootNamespace(devFixture.root);
    expect(prodNamespace).not.toBe(devNamespace);

    const prodJobId = `coexist-prod-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const devJobId = `coexist-dev-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const prodProjectRoot = join(tempHome, 'project-prod');
    const devProjectRoot = join(tempHome, 'project-dev');
    seedCompletedJob(prodJobId, prodNamespace, prodProjectRoot, prodFixture.bundleHash, 'prod');
    seedCompletedJob(devJobId, devNamespace, devProjectRoot, devFixture.bundleHash, 'dev');

    startedPluginRoots.push(prodFixture.root, devFixture.root);
    await ensureFixtureBackend(prodFixture.root);
    await ensureFixtureBackend(devFixture.root);

    const prodInfo = await requireBackendInfo(prodFixture.root);
    const devInfo = await requireBackendInfo(devFixture.root);

    expect(prodInfo.flavor).toBe('prod');
    expect(devInfo.flavor).toBe('dev');
    expect(prodInfo.bundleHash).toBe(sourceManifest.bundleHash);
    expect(devInfo.bundleHash).toBe(sourceManifest.bundleHash);
    expect(prodInfo.namespace).toBe(prodNamespace);
    expect(devInfo.namespace).toBe(devNamespace);
    expect(prodInfo.pid).not.toBe(process.pid);
    expect(devInfo.pid).not.toBe(process.pid);
    expect(prodInfo.pid).not.toBe(devInfo.pid);
    expect(prodInfo.port).not.toBe(devInfo.port);

    const prodHealth = await fetchJson<BackendHealth>(prodInfo, '/health');
    const devHealth = await fetchJson<BackendHealth>(devInfo, '/health');
    expect(prodHealth.flavor).toBe('prod');
    expect(devHealth.flavor).toBe('dev');
    expect(prodHealth.namespace).toBe(prodNamespace);
    expect(devHealth.namespace).toBe(devNamespace);
    expect(prodHealth.instanceId).toBe(prodInfo.instanceId);
    expect(devHealth.instanceId).toBe(devInfo.instanceId);

    const prodJobs = await fetchJson<{ jobs: Array<{ jobId: string; status: JobStatus }> }>(
      prodInfo,
      `/jobs?all=1&projectRoot=${encodeURIComponent(prodProjectRoot)}`,
    );
    const devJobs = await fetchJson<{ jobs: Array<{ jobId: string; status: JobStatus }> }>(
      devInfo,
      `/jobs?all=1&projectRoot=${encodeURIComponent(devProjectRoot)}`,
    );

    expect(prodJobs.jobs.map((job) => job.jobId)).toEqual([prodJobId]);
    expect(devJobs.jobs.map((job) => job.jobId)).toEqual([devJobId]);
    expect(prodJobs.jobs[0]?.status.backendNamespace).toBe(prodNamespace);
    expect(devJobs.jobs[0]?.status.backendNamespace).toBe(devNamespace);

    await fetchJson<{ status: JobStatus; events: unknown[] }>(
      prodInfo,
      `/jobs/${prodJobId}?projectRoot=${encodeURIComponent(prodProjectRoot)}`,
    );
    await fetchJson<{ status: JobStatus; events: unknown[] }>(
      devInfo,
      `/jobs/${devJobId}?projectRoot=${encodeURIComponent(devProjectRoot)}`,
    );

    const prodForeignLookup = await fetchJson<{ code: string; message: string }>(
      prodInfo,
      `/jobs/${devJobId}?projectRoot=${encodeURIComponent(prodProjectRoot)}`,
      404,
    );
    const devForeignLookup = await fetchJson<{ code: string; message: string }>(
      devInfo,
      `/jobs/${prodJobId}?projectRoot=${encodeURIComponent(devProjectRoot)}`,
      404,
    );

    expect(prodForeignLookup.code).toBe('job_not_found');
    expect(devForeignLookup.code).toBe('job_not_found');
  });
});
