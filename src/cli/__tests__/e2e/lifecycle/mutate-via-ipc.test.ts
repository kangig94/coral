import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
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

import type { CoordinatorDiscoveryRecord } from '../../../../coordinator/discovery.js';
import { coordinatorPaths } from '../../../../coordinator/paths.js';
import { isProcessAlive } from '../../../../shared/node-process.js';
import { readBuildFlavor } from '../../../../shared/utils.js';
import { createIpcClient } from '../../../../transport/ipc/client.js';
import { CoralStore, openStoreDatabase } from '../../../../store/index.js';
import { createDefaultStoreReadContext } from '../../../../store/read-context.js';
import { createRealRuntime } from '../../../../runtime/real.js';
import { storePaths } from '../../../../store/paths.js';

const REPO_ROOT = process.cwd();
const SOURCE_BACKEND_BUNDLE = join(REPO_ROOT, 'build', 'coral-backend.cjs');
const SOURCE_CLI_BUNDLE = join(REPO_ROOT, 'build', 'coral-cli.cjs');
const SOURCE_MANIFEST = join(REPO_ROOT, 'build', 'manifest.json');
const SOURCE_MIGRATIONS_DIR = join(REPO_ROOT, 'dist', 'store', 'migrations');
const SOURCE_SQLITE3_DIR = join(REPO_ROOT, 'node_modules', 'better-sqlite3');

const tempRoots: string[] = [];

type Fixture = {
  root: string;
  home: string;
  projectRoot: string;
  flavor: 'prod' | 'dev';
};

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-mutate-plugin-'));
  const home = mkdtempSync(join(tmpdir(), 'coral-ipc-mutate-home-'));
  const projectRoot = join(root, 'project');

  tempRoots.push(root, home);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  copyFileSync(SOURCE_BACKEND_BUNDLE, join(root, 'bridge', 'coral-backend.cjs'));
  copyFileSync(SOURCE_CLI_BUNDLE, join(root, 'bridge', 'coral-cli.cjs'));
  copyFileSync(SOURCE_MANIFEST, join(root, 'bridge', 'manifest.json'));
  cpSync(SOURCE_MIGRATIONS_DIR, join(root, 'dist', 'store', 'migrations'), { recursive: true });

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(SOURCE_SQLITE3_DIR, join(root, 'node_modules', 'better-sqlite3'), 'dir');

  return {
    root,
    home,
    projectRoot,
    flavor: readBuildFlavor(root),
  };
}

function discoveryFilePath(home: string, flavor: 'prod' | 'dev'): string {
  return coordinatorPaths(flavor, { HOME: home, TMPDIR: home }, { baseDir: join(home, '.coral') }).infoFile;
}

function resultArtifactPath(home: string, jobId: string): string {
  return join(home, 'coral-jobs', jobId, 'result.md');
}

function readDiscoveryRecord(home: string, flavor: 'prod' | 'dev'): CoordinatorDiscoveryRecord | null {
  const filePath = discoveryFilePath(home, flavor);
  if (!existsSync(filePath)) {
    return null;
  }
  return JSON.parse(readFileSync(filePath, 'utf-8')) as CoordinatorDiscoveryRecord;
}

async function waitForCondition(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

async function shutdownCoordinator(record: CoordinatorDiscoveryRecord | null): Promise<void> {
  if (!record || !isProcessAlive(record.pid)) {
    return;
  }

  try {
    await createIpcClient(record.socketPath).shutdown({ timeoutMs: 5_000 });
  } catch {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch (error: unknown) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ESRCH') {
        throw error;
      }
    }
  }

  await waitForCondition(() => !isProcessAlive(record.pid), 10_000).catch(() => {
    if (isProcessAlive(record.pid)) {
      try {
        process.kill(record.pid, 'SIGKILL');
      } catch (error: unknown) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code !== 'ESRCH') {
          throw error;
        }
      }
    }
  });
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('mutating commands via IPC', () => {
  it('auto-launches the coordinator and completes coral-cli codex through the scripted provider', async () => {
    if (!existsSync(SOURCE_BACKEND_BUNDLE) || !existsSync(SOURCE_CLI_BUNDLE) || !existsSync(SOURCE_MANIFEST)) {
      throw new Error('Expected build/coral-backend.cjs, build/coral-cli.cjs, and build/manifest.json to exist.');
    }

    const fixture = createFixture();
    const promptPath = join(fixture.projectRoot, 'prompt.txt');
    writeFileSync(promptPath, 'hello over ipc', 'utf-8');

    expect(readDiscoveryRecord(fixture.home, fixture.flavor)).toBeNull();

    const scriptedProviderSpec = JSON.stringify({
      name: 'codex',
      progress: [{ message: 'scripted progress from ipc provider' }],
      result: {
        content: 'scripted terminal output',
        conversationRef: 'scripted-codex-session',
        outcome: { kind: 'completed' },
      },
    });

    let discoveryRecord: CoordinatorDiscoveryRecord | null = null;
    try {
      const result = spawnSync('node', [join(fixture.root, 'bridge', 'coral-cli.cjs'), 'codex', '-i', promptPath], {
        cwd: fixture.projectRoot,
        env: {
          ...process.env,
          HOME: fixture.home,
          TMPDIR: fixture.home,
          CORAL_SCRIPTED_PROVIDER_SPEC: scriptedProviderSpec,
        },
        encoding: 'utf-8',
        timeout: 90_000,
      });

      if (result.error) {
        throw result.error;
      }

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('scripted progress from ipc provider');

      const launchMatch = result.stdout.match(/^Job (\S+) (running|queued) \(session (\S+)\)$/m);
      expect(launchMatch).not.toBeNull();

      const terminalMatch = result.stdout.match(/^Job (\S+) completed$/m);
      expect(terminalMatch).not.toBeNull();

      const resultPathMatch = result.stdout.match(/^Result path: (.+)$/m);
      expect(resultPathMatch).not.toBeNull();

      await waitForCondition(() => readDiscoveryRecord(fixture.home, fixture.flavor) !== null, 10_000);
      discoveryRecord = readDiscoveryRecord(fixture.home, fixture.flavor);

      expect(discoveryRecord).not.toBeNull();
      expect(discoveryRecord && isProcessAlive(discoveryRecord.pid)).toBe(true);
      expect(discoveryRecord?.socketPath).toContain('.sock');

      const runtime = createRealRuntime();
      const db = openStoreDatabase({
        path: storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile,
        storage: runtime.storage,
        readonly: true,
      });

      try {
        const store = new CoralStore(db, createDefaultStoreReadContext());
        const jobs = store.jobs.list({ projectRoot: fixture.projectRoot, all: true });
        expect(jobs).toHaveLength(1);

        const jobId = jobs[0]?.jobId;
        const detail = jobId ? store.jobs.detail(jobId) : null;
        const sessionId = detail?.status.sessionId;
        const resultPath = jobId ? resultArtifactPath(fixture.home, jobId) : null;

        expect(detail?.status.phase).toBe('completed');
        expect(detail?.status.sessionId).toBe(sessionId);
        expect(detail?.status.result?.content).toBe('scripted terminal output');
        expect(resultPath).toBeDefined();
        expect(resultPath && existsSync(resultPath)).toBe(true);
        expect(resultPath && readFileSync(resultPath, 'utf-8')).toBe('scripted terminal output');

        expect(launchMatch?.[1]).toBe(jobId);
        expect(launchMatch?.[3]).toBe(sessionId);
        expect(terminalMatch?.[1]).toBe(jobId);
        expect(resultPathMatch?.[1]).toBe(resultPath);
      } finally {
        db.close();
      }
    } finally {
      await shutdownCoordinator(discoveryRecord ?? readDiscoveryRecord(fixture.home, fixture.flavor));
    }
  }, 120_000);
});
