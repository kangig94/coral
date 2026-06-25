import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

import type { CoordinatorDiscoveryRecord } from '#src/infra/backend-discovery.js';
import { coordinatorPaths } from '#src/infra/path/coordinator.js';
import { isProcessAlive } from '#src/infra/node-process.js';
import { readBuildFlavor } from '#src/infra/bundle-manifest.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { openStoreDatabase } from '#src/store/db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { storePaths } from '#src/infra/path/store.js';

const REPO_ROOT = process.cwd();
const SOURCE_BACKEND_BUNDLE = join(REPO_ROOT, 'build', 'coral-backend.cjs');
const SOURCE_CLI_BUNDLE = join(REPO_ROOT, 'build', 'coral-cli.cjs');
const SOURCE_MANIFEST = join(REPO_ROOT, 'build', 'manifest.json');
const SOURCE_SQLITE3_DIR = join(REPO_ROOT, 'node_modules', 'better-sqlite3');

const tempRoots: string[] = [];

type Fixture = {
  root: string;
  home: string;
  projectRoot: string;
  binDir: string;
  flavor: 'prod' | 'dev';
};

const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
const readline = require('node:readline');

if (process.argv[2] === 'app-server' && process.argv[3] === '--help') {
  process.stdout.write('fake codex app-server\\n');
  process.exit(0);
}

if (process.argv[2] !== 'app-server') {
  process.stderr.write('unsupported fake codex command\\n');
  process.exit(1);
}

const threadId = 'scripted-codex-session';
const turnId = 'scripted-codex-turn';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {} });
      break;
    case 'thread/start':
      send({
        method: 'thread/started',
        params: {
          thread: { id: threadId },
        },
      });
      send({ id: message.id, result: { thread: { id: threadId } } });
      break;
    case 'turn/start':
      send({
        method: 'turn/started',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'inProgress',
          },
        },
      });
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      send({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          item: {
            type: 'agentMessage',
            phase: 'final_answer',
            text: 'scripted terminal output',
          },
        },
      });
      send({
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: turnId,
            status: 'completed',
          },
        },
      });
      break;
    case 'turn/interrupt':
      send({ id: message.id, result: { threadId, turnId } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported method' } });
      break;
  }
});
`;

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-mutate-plugin-'));
  const home = mkdtempSync(join(tmpdir(), 'coral-ipc-mutate-home-'));
  const projectRoot = join(root, 'project');
  const binDir = join(root, 'bin');

  tempRoots.push(root, home);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  copyFileSync(SOURCE_BACKEND_BUNDLE, join(root, 'bridge', 'coral-backend.cjs'));
  copyFileSync(SOURCE_CLI_BUNDLE, join(root, 'bridge', 'coral-cli.cjs'));
  copyFileSync(SOURCE_MANIFEST, join(root, 'bridge', 'manifest.json'));
  writeFileSync(join(binDir, 'codex'), FAKE_CODEX_APP_SERVER, 'utf-8');
  chmodSync(join(binDir, 'codex'), 0o755);
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access-token' } }),
    'utf-8',
  );

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(SOURCE_SQLITE3_DIR, join(root, 'node_modules', 'better-sqlite3'), 'dir');

  return {
    root,
    home,
    projectRoot,
    binDir,
    flavor: readBuildFlavor(root),
  };
}

function discoveryFilePath(home: string, flavor: 'prod' | 'dev'): string {
  return coordinatorPaths(flavor, { HOME: home, TMPDIR: home }, { baseDir: join(home, '.coral') }).infoFile;
}

function resultArtifactPath(home: string, flavor: 'prod' | 'dev', jobId: string): string {
  const exportsDir = flavor === 'dev' ? 'exports-dev' : 'exports';
  return join(home, '.coral', exportsDir, 'jobs', jobId, 'result.md');
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

async function shutdownBackend(record: CoordinatorDiscoveryRecord | null): Promise<void> {
  if (!record || !isProcessAlive(record.pid)) {
    return;
  }

  try {
    await createIpcClient(record.socketPath).shutdown(
      { shutdownToken: record.shutdownToken },
      { timeoutMs: 5_000 },
    );
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
  it('auto-launches the coordinator and completes coral-cli codex through a fake Codex app-server', async () => {
    if (!existsSync(SOURCE_BACKEND_BUNDLE) || !existsSync(SOURCE_CLI_BUNDLE) || !existsSync(SOURCE_MANIFEST)) {
      throw new Error('Expected build/coral-backend.cjs, build/coral-cli.cjs, and build/manifest.json to exist.');
    }

    const fixture = createFixture();
    const promptPath = join(fixture.projectRoot, 'prompt.txt');
    writeFileSync(promptPath, 'hello over ipc', 'utf-8');

    expect(readDiscoveryRecord(fixture.home, fixture.flavor)).toBeNull();

    let discoveryRecord: CoordinatorDiscoveryRecord | null = null;
    try {
      const result = spawnSync('node', [join(fixture.root, 'bridge', 'coral-cli.cjs'), 'codex', '-i', promptPath], {
        cwd: fixture.projectRoot,
        env: {
          ...process.env,
          HOME: fixture.home,
          TMPDIR: fixture.home,
          PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        },
        encoding: 'utf-8',
        timeout: 90_000,
      });

      if (result.error) {
        throw result.error;
      }

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Thread ready (scripted-codex-session).');

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

      const runtime = createRealRuntime('prod');
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
        const resultPath = jobId ? resultArtifactPath(fixture.home, fixture.flavor, jobId) : null;

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
      await shutdownBackend(discoveryRecord ?? readDiscoveryRecord(fixture.home, fixture.flavor));
    }
  }, 120_000);
});
