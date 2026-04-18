import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackendHealth } from '../../client/backend-health.js';
import { ensureBackend } from '../../client/backend-lifecycle.js';
import { readBackendInfo, type BackendInfo } from '../../infra/backend-info.js';
import { jobsDir, pluginRootNamespace } from '../../infra/paths.js';
import { isProcessAlive } from '../../shared/node-process.js';
import type { JobStatusRecord } from '../../shared/types.js';

const sourceBackendBundle = join(process.cwd(), 'build', 'coral-backend.cjs');
const sourceManifest = JSON.parse(readFileSync(join(process.cwd(), 'build', 'manifest.json'), 'utf-8')) as {
  bundleHash: string;
};

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
    rmSync(join(jobsDir(), jobId), { recursive: true, force: true });
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
    JSON.stringify({ bundleHash: sourceManifest.bundleHash, flavor }) + '\n',
    'utf-8',
  );
  return { root, bundleHash: sourceManifest.bundleHash, manifestFlavor: flavor };
}

function seedCompletedJob(jobId: string, namespace: string, projectRoot: string, bundleHash: string): void {
  createdJobIds.push(jobId);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(jobsDir(), jobId), { recursive: true });

  const status: JobStatusRecord = {
    jobId,
    sessionId: `${jobId}-session`,
    provider: 'codex',
    projectRoot,
    backendNamespace: namespace,
    bundleHash,
    phase: 'completed',
    launch: {
      state: 'ready',
      updatedAt: new Date().toISOString(),
    },
    result: {
      content: `${jobId}-done`,
      outcome: { kind: 'completed' },
    },
  };

  writeFileSync(join(jobsDir(), jobId, 'status.json'), JSON.stringify(status, null, 2), 'utf-8');
}

async function requireBackendInfo(pluginRoot: string): Promise<BackendInfo> {
  await waitForCondition(() => readBackendInfo(pluginRoot) !== null);
  const info = readBackendInfo(pluginRoot);
  if (!info) {
    throw new Error(`Expected backend info for ${pluginRoot}`);
  }
  return info;
}

async function fetchJson<T>(info: BackendInfo, path: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(`http://${info.host}:${info.port}${path}`, {
    headers: { 'X-Coral-Backend-Token': info.token },
  });
  expect(response.status).toBe(expectedStatus);
  return (await response.json()) as T;
}

async function stopBackend(pluginRoot: string): Promise<void> {
  const info = readBackendInfo(pluginRoot);
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

    const prodManifest = JSON.parse(
      readFileSync(join(prodFixture.root, 'bridge', 'manifest.json'), 'utf-8'),
    ) as { bundleHash: string; flavor: 'prod' | 'dev' };
    const devManifest = JSON.parse(
      readFileSync(join(devFixture.root, 'bridge', 'manifest.json'), 'utf-8'),
    ) as { bundleHash: string; flavor: 'prod' | 'dev' };

    expect(prodManifest).toEqual({ bundleHash: sourceManifest.bundleHash, flavor: 'prod' });
    expect(devManifest).toEqual({ bundleHash: sourceManifest.bundleHash, flavor: 'dev' });

    const prodNamespace = pluginRootNamespace(prodFixture.root);
    const devNamespace = pluginRootNamespace(devFixture.root);
    expect(prodNamespace).not.toBe(devNamespace);

    const prodJobId = `coexist-prod-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const devJobId = `coexist-dev-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    seedCompletedJob(prodJobId, prodNamespace, join(tempHome, 'project-prod'), prodFixture.bundleHash);
    seedCompletedJob(devJobId, devNamespace, join(tempHome, 'project-dev'), devFixture.bundleHash);

    startedPluginRoots.push(prodFixture.root, devFixture.root);
    await ensureBackend(prodFixture.root);
    await ensureBackend(devFixture.root);

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

    const prodJobs = await fetchJson<{ jobs: Array<{ jobId: string; status: JobStatusRecord }> }>(prodInfo, '/jobs');
    const devJobs = await fetchJson<{ jobs: Array<{ jobId: string; status: JobStatusRecord }> }>(devInfo, '/jobs');

    expect(prodJobs.jobs.map((job) => job.jobId)).toEqual([prodJobId]);
    expect(devJobs.jobs.map((job) => job.jobId)).toEqual([devJobId]);
    expect(prodJobs.jobs[0]?.status.backendNamespace).toBe(prodNamespace);
    expect(devJobs.jobs[0]?.status.backendNamespace).toBe(devNamespace);

    await fetchJson<{ status: JobStatusRecord; events: unknown[] }>(prodInfo, `/jobs/${prodJobId}`);
    await fetchJson<{ status: JobStatusRecord; events: unknown[] }>(devInfo, `/jobs/${devJobId}`);

    const prodForeignLookup = await fetchJson<{ code: string; message: string }>(
      prodInfo,
      `/jobs/${devJobId}`,
      404,
    );
    const devForeignLookup = await fetchJson<{ code: string; message: string }>(
      devInfo,
      `/jobs/${prodJobId}`,
      404,
    );

    expect(prodForeignLookup.code).toBe('job_not_found');
    expect(devForeignLookup.code).toBe('job_not_found');
  });
});
