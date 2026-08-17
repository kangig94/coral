import { currentCoralStoreFormat } from '#src/store-format.js';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { observeProcessLiveness } from '#src/infra/node-process.js';
import { readBuildFlavor } from '#src/infra/bundle-manifest.js';
import { createIpcClient } from '#src/transport/ipc/client.js';
import { CoralStore } from '#src/read-model/coral-store.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { openStoreDatabase } from '#src/store/db.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { storePaths } from '#src/infra/path/store.js';
import { readProviderOperationForJob } from '#src/store/provider-operation-journal.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { assertLifecycleBundleSetFresh } from '#tests/support/bundle-build-freshness.js';

const REPO_ROOT = process.cwd();
const SOURCE_BACKEND_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-backend.cjs');
const SOURCE_CLI_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-cli.cjs');
const SOURCE_CLAUDE_APPSERVER_BUNDLE = join(REPO_ROOT, 'clients', 'build', 'coral-claude-appserver.cjs');
const SOURCE_MANIFEST = join(REPO_ROOT, 'clients', 'build', 'manifest.json');
const SOURCE_SQLITE3_DIR = join(REPO_ROOT, 'node_modules', 'better-sqlite3');

const tempRoots: string[] = [];

type Fixture = {
  root: string;
  home: string;
  projectRoot: string;
  binDir: string;
  fakeStateDir: string;
  flavor: 'prod' | 'dev';
};

const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

if (process.argv[2] === 'app-server' && process.argv[3] === '--help') {
  process.stdout.write('fake codex app-server\\n');
  process.exit(0);
}

if (process.argv[2] !== 'app-server') {
  process.stderr.write('unsupported fake codex command\\n');
  process.exit(1);
}

const stateHome = process.env.HOME;
if (!stateHome) {
  process.stderr.write('HOME is required\\n');
  process.exit(1);
}
const stateDir = path.join(stateHome, '.fake-codex-state');
let secondOperation = false;

function signal(name) {
  fs.writeFileSync(path.join(stateDir, name), 'ready');
}

function afterGate(name, action) {
  const gatePath = path.join(stateDir, name);
  const poll = () => {
    if (fs.existsSync(gatePath)) {
      action();
      return;
    }
    setTimeout(poll, 10);
  };
  poll();
}

function trace(event) {
  fs.appendFileSync(path.join(stateDir, 'ordered-trace'), event + '\\n');
}

function record(name, value) {
  fs.appendFileSync(path.join(stateDir, name), JSON.stringify(value) + '\\n');
}

const providerHostId = String(process.pid);
record('provider-host-placements', { hostId: providerHostId });

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
    case 'config/read':
      const attemptId = providerHostId + ':config/read:' + message.id;
      record('config-read-attempts', { hostId: providerHostId, requestId: message.id, attemptId });
      if (fs.existsSync(path.join(stateDir, 'fail-config-read'))) {
        send({
          id: message.id,
          error: {
            code: -32603,
            message: 'configuration refused',
            data: { reason: 'poisoned cwd', attemptId },
          },
        });
      } else {
        send({ id: message.id, result: { config: {} } });
      }
      break;
    case 'thread/start':
      secondOperation = fs.existsSync(path.join(stateDir, 'second-operation-armed'));
      signal('thread-start-pending-' + (secondOperation ? 2 : 1));
      afterGate('thread-start-gate-' + (secondOperation ? 2 : 1), () => {
        if (secondOperation) trace('fake thread/start');
        send({
          method: 'thread/started',
          params: {
            thread: { id: threadId },
          },
        });
        send({ id: message.id, result: { thread: { id: threadId } } });
      });
      break;
    case 'turn/start':
      const answerTurn = () => {
        if (secondOperation) trace('fake turn/start');
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
        if (secondOperation) fs.appendFileSync(path.join(stateDir, 'terminal-events'), 'terminal\\n');
      };
      if (secondOperation) {
        signal('turn-start-pending-2');
        afterGate('turn-start-gate-2', answerTurn);
      } else {
        answerTurn();
      }
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
  const fakeStateDir = join(home, '.fake-codex-state');

  tempRoots.push(root, home);

  mkdirSync(join(root, 'bridge'), { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(fakeStateDir, { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  copyFileSync(SOURCE_BACKEND_BUNDLE, join(root, 'bridge', 'coral-backend.cjs'));
  copyFileSync(SOURCE_CLI_BUNDLE, join(root, 'bridge', 'coral-cli.cjs'));
  // The coordinator validates its whole adjacent build set at startup, so the
  // Claude appserver bundle must be present or boot aborts on build identity.
  copyFileSync(SOURCE_CLAUDE_APPSERVER_BUNDLE, join(root, 'bridge', 'coral-claude-appserver.cjs'));
  copyFileSync(SOURCE_MANIFEST, join(root, 'bridge', 'manifest.json'));
  writeFileSync(join(binDir, 'codex'), FAKE_CODEX_APP_SERVER, 'utf-8');
  chmodSync(join(binDir, 'codex'), 0o755);
  // `account_id` is what makes this a bindable ChatGPT-mode profile: Codex
  // account binding resolves its subject from it. Without it the launch fails
  // on provider identity before the coordinator is ever exercised.
  writeFileSync(
    join(home, '.codex', 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access-token', account_id: 'fake-account-id' } }),
    'utf-8',
  );

  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(SOURCE_SQLITE3_DIR, join(root, 'node_modules', 'better-sqlite3'), 'dir');

  return {
    root,
    home,
    projectRoot,
    binDir,
    fakeStateDir,
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

type CliRun = Readonly<{
  stdout(): string;
  stderr(): string;
  completed: Promise<number>;
}>;

function startCliCommand(fixture: Fixture, args: readonly string[]): CliRun {
  const {
    CORAL_CHILD: _coralChild,
    CORAL_CHILD_PRINCIPAL_HANDLE: _childPrincipal,
    CORAL_JOB_ID: _coralJobId,
    CORAL_SESSION_ID: _coralSessionId,
    ...topLevelEnv
  } = process.env;
  const child = spawn('node', [join(fixture.root, 'bridge', 'coral-cli.cjs'), ...args], {
    cwd: fixture.projectRoot,
    env: {
      ...topLevelEnv,
      HOME: fixture.home,
      TMPDIR: fixture.home,
      PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const completed = new Promise<number>((resolve, reject) => {
    let timeoutFailure: Error | null = null;
    const timeout = setTimeout(() => {
      timeoutFailure = new Error(`coral-cli timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      child.kill('SIGKILL');
    }, 90_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status) => {
      clearTimeout(timeout);
      if (timeoutFailure !== null) reject(timeoutFailure);
      else resolve(status ?? -1);
    });
  });
  return { stdout: () => stdout, stderr: () => stderr, completed };
}

function startCli(fixture: Fixture, promptPath: string): CliRun {
  return startCliCommand(fixture, ['codex', '-i', promptPath]);
}

function launchedJobId(stdout: string): string | null {
  return stdout.match(/^Provider job (\S+) (?:launch accepted|queued) \(provider session \S+\)$/m)?.[1] ?? null;
}

async function waitForCliGate(run: CliRun, check: () => boolean, label: string): Promise<void> {
  await Promise.race([
    waitForCondition(check, 30_000),
    run.completed.then((status) => {
      throw new Error(
        `${label} was never reached before coral-cli exited with status ${String(status)}\nstdout:\n${run.stdout()}\nstderr:\n${run.stderr()}`,
      );
    }),
  ]);
}

function readDurableOperation(fixture: Fixture, jobId: string): ProviderOperationRecord | null {
  const runtime = createRealRuntime('prod');
  const db = openStoreDatabase({
    storeFormat: currentCoralStoreFormat(),
    path: storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile,
    storage: runtime.storage,
    readonly: true,
  });
  try {
    return readProviderOperationForJob(db, jobId);
  } finally {
    db.close();
  }
}

function requireDurableOperation(fixture: Fixture, jobId: string): ProviderOperationRecord {
  const record = readDurableOperation(fixture, jobId);
  if (record === null) throw new Error(`provider operation for ${jobId} was not durably readable`);
  return record;
}

async function waitForExactProviderWatermark(
  fixture: Fixture,
  jobId: string,
  watermark: number,
): Promise<ProviderOperationRecord & { phase: 'executing' }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const record = readDurableOperation(fixture, jobId);
    if (record?.phase === 'executing') {
      if (record.committedThroughProviderSeq === watermark) return record;
      if (record.committedThroughProviderSeq > watermark) {
        throw new Error(
          `provider watermark advanced to ${record.committedThroughProviderSeq} before ${watermark} was observed`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for provider watermark ${watermark}`);
}

function appendOrderedTrace(fixture: Fixture, event: string): void {
  writeFileSync(join(fixture.fakeStateDir, 'ordered-trace'), `${event}\n`, { flag: 'a' });
}

function readFakeRecords<RecordShape>(fixture: Fixture, name: string): RecordShape[] {
  return readFileSync(join(fixture.fakeStateDir, name), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RecordShape);
}

function providerSocketCount(fixture: Fixture): number {
  const coralRoot = join(fixture.home, '.coral');
  if (!existsSync(coralRoot)) return 0;
  return readdirSync(coralRoot, { recursive: true }).filter(
    (entry) => typeof entry === 'string' && entry.includes('provider-') && entry.endsWith('.sock'),
  ).length;
}

async function shutdownBackend(record: CoordinatorDiscoveryRecord | null): Promise<void> {
  // Observed life, not 'not proven gone'. This helper signals a bare pid, so it acts only on the one
  // answer that says the recorded process is there.
  if (!record || observeProcessLiveness(record.pid) !== 'alive') {
    return;
  }

  try {
    await createIpcClient(record.socketPath, undefined, { kind: 'boot', token: record.bootToken }).shutdown({
      timeoutMs: 5_000,
    });
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

  await waitForCondition(() => observeProcessLiveness(record.pid) === 'absent', 10_000).catch(() => {
    if (observeProcessLiveness(record.pid) === 'alive') {
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
  it("shows exact inspect and evict recovery when the initial job's config/read fails", async () => {
    assertLifecycleBundleSetFresh(REPO_ROOT);

    const fixture = createFixture();
    const promptPath = join(fixture.projectRoot, 'poisoned-prompt.txt');
    writeFileSync(promptPath, 'exercise the poisoned provider host', 'utf-8');
    writeFileSync(join(fixture.fakeStateDir, 'fail-config-read'), 'armed');

    let discoveryRecord: CoordinatorDiscoveryRecord | null = null;
    try {
      const launch = startCli(fixture, promptPath);
      expect(await launch.completed).toBe(1);
      expect(launch.stderr()).toBe('');
      const jobId = launchedJobId(launch.stdout());
      if (jobId === null) throw new Error('failed CLI never reported its provider job id');

      await waitForCondition(() => readDiscoveryRecord(fixture.home, fixture.flavor) !== null, 10_000);
      discoveryRecord = readDiscoveryRecord(fixture.home, fixture.flavor);
      const wait = startCliCommand(fixture, ['wait', 'jobs', jobId]);
      expect(await wait.completed).toBe(1);
      expect(wait.stderr()).toBe('');

      const visibleTerminal = wait.stdout();
      const placements = readFakeRecords<{ hostId: string }>(fixture, 'provider-host-placements');
      const configReadAttempts = readFakeRecords<{ hostId: string; requestId: number; attemptId: string }>(
        fixture,
        'config-read-attempts',
      );
      expect(placements).toHaveLength(1);
      expect(configReadAttempts).toHaveLength(1);
      expect(configReadAttempts[0]?.hostId).toBe(placements[0]?.hostId);
      const initialAttempt = configReadAttempts[0];
      if (initialAttempt === undefined) throw new Error('fake Codex recorded no initial config/read attempt');
      expect(visibleTerminal).toContain(
        `config/read failed [code=-32603]: configuration refused; data=${JSON.stringify({
          reason: 'poisoned cwd',
          attemptId: initialAttempt.attemptId,
        })}`,
      );
      const encodedHostRef = visibleTerminal.match(/ph1\.[A-Za-z0-9_-]+/)?.[0];
      expect(encodedHostRef).toBeDefined();
      expect(visibleTerminal).toContain(`coral-cli backend provider-host inspect ${encodedHostRef}`);
      expect(visibleTerminal).toContain(`coral-cli backend provider-host evict ${encodedHostRef}`);
      expect(visibleTerminal.indexOf('config/read failed')).toBeLessThan(
        visibleTerminal.indexOf(`provider-host inspect ${encodedHostRef}`),
      );

      const runtime = createRealRuntime('prod');
      const db = openStoreDatabase({
        storeFormat: currentCoralStoreFormat(),
        path: storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile,
        storage: runtime.storage,
        readonly: true,
      });
      try {
        expect(new CoralStore(db, createDefaultStoreReadContext()).jobs.list({ all: true })).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      await shutdownBackend(discoveryRecord ?? readDiscoveryRecord(fixture.home, fixture.flavor));
    }
  }, 120_000);

  it('routes two durable operations through the discovered proxy before each faithful Codex checkpoint', async () => {
    assertLifecycleBundleSetFresh(REPO_ROOT);

    if (
      !existsSync(SOURCE_BACKEND_BUNDLE) ||
      !existsSync(SOURCE_CLI_BUNDLE) ||
      !existsSync(SOURCE_CLAUDE_APPSERVER_BUNDLE) ||
      !existsSync(SOURCE_MANIFEST)
    ) {
      throw new Error('Expected a built Coral bundle set under clients/build/ before running lifecycle E2E tests.');
    }

    const fixture = createFixture();
    const firstPromptPath = join(fixture.projectRoot, 'first-prompt.txt');
    const secondPromptPath = join(fixture.projectRoot, 'second-prompt.txt');
    writeFileSync(firstPromptPath, 'first hello over ipc', 'utf-8');
    writeFileSync(secondPromptPath, 'second hello over ipc', 'utf-8');

    expect(readDiscoveryRecord(fixture.home, fixture.flavor)).toBeNull();

    let discoveryRecord: CoordinatorDiscoveryRecord | null = null;
    try {
      const first = startCli(fixture, firstPromptPath);
      await waitForCliGate(
        first,
        () =>
          existsSync(join(fixture.fakeStateDir, 'thread-start-pending-1')) && launchedJobId(first.stdout()) !== null,
        'first thread/start gate',
      );
      const firstJobId = launchedJobId(first.stdout());
      if (firstJobId === null) throw new Error('first CLI never reported its provider job id');
      writeFileSync(join(fixture.fakeStateDir, 'thread-start-gate-1'), 'continue');

      const firstStatus = await first.completed;
      if (firstStatus !== 0) {
        throw new Error(
          `first coral-cli exited with status ${String(firstStatus)}\nstdout:\n${first.stdout()}\nstderr:\n${first.stderr()}`,
        );
      }
      expect(first.stderr()).toBe('');
      expect(first.stdout()).toContain('Thread ready (scripted-codex-session).');
      expect(first.stdout()).toMatch(new RegExp(`^Job ${firstJobId} completed$`, 'm'));

      await waitForCondition(() => providerSocketCount(fixture) >= 3, 10_000);
      writeFileSync(join(fixture.fakeStateDir, 'second-operation-armed'), 'armed');
      const second = startCli(fixture, secondPromptPath);
      await waitForCliGate(
        second,
        () =>
          existsSync(join(fixture.fakeStateDir, 'thread-start-pending-2')) && launchedJobId(second.stdout()) !== null,
        'second thread/start gate',
      );
      const secondJobId = launchedJobId(second.stdout());
      if (secondJobId === null) throw new Error('second CLI never reported its provider job id');
      await waitForCondition(() => readDurableOperation(fixture, secondJobId) !== null, 10_000);
      const secondOperationBeforeThread = requireDurableOperation(fixture, secondJobId);
      expect(secondOperationBeforeThread.operation).toMatchObject({
        jobId: secondJobId,
        proxyInstanceId: secondOperationBeforeThread.locator.proxy.instanceId,
      });
      expect(Object.keys(secondOperationBeforeThread.locator).sort()).toEqual([
        'containment',
        'guardian',
        'hostFingerprint',
        'proxy',
        'reaper',
      ]);
      expect(observeProcessLiveness(secondOperationBeforeThread.locator.proxy.pid)).toBe('alive');
      expect(observeProcessLiveness(secondOperationBeforeThread.locator.guardian.pid)).toBe('alive');
      expect(observeProcessLiveness(secondOperationBeforeThread.locator.reaper.pid)).toBe('alive');
      expect(secondOperationBeforeThread.locator.containment).toMatchObject({
        pid: secondOperationBeforeThread.locator.proxy.pid,
        incarnation: secondOperationBeforeThread.locator.proxy.incarnation,
      });
      appendOrderedTrace(fixture, 'second operation durable proxy locator');
      const durableContinuityAck = waitForExactProviderWatermark(fixture, secondJobId, 1);
      writeFileSync(join(fixture.fakeStateDir, 'thread-start-gate-2'), 'continue');

      await durableContinuityAck;
      appendOrderedTrace(fixture, 'durable provider watermark 1 / ACK');
      await waitForCliGate(
        second,
        () => existsSync(join(fixture.fakeStateDir, 'turn-start-pending-2')),
        'second turn/start gate',
      );
      const secondOperationAtTurn = requireDurableOperation(fixture, secondJobId);
      if (secondOperationAtTurn.phase !== 'executing') {
        throw new Error(`second operation reached turn/start from phase ${secondOperationAtTurn.phase}`);
      }
      expect(secondOperationAtTurn.committedThroughProviderSeq).toBeGreaterThanOrEqual(1);
      writeFileSync(join(fixture.fakeStateDir, 'turn-start-gate-2'), 'continue');

      const secondStatus = await second.completed;
      if (secondStatus !== 0) {
        throw new Error(
          `second coral-cli exited with status ${String(secondStatus)}\nstdout:\n${second.stdout()}\nstderr:\n${second.stderr()}`,
        );
      }
      expect(second.stderr()).toBe('');
      expect(second.stdout()).toContain('Thread ready (scripted-codex-session).');
      expect(second.stdout()).toMatch(new RegExp(`^Job ${secondJobId} completed$`, 'm'));
      await waitForCondition(() => readDurableOperation(fixture, secondJobId) === null, 10_000);

      const terminalEvents = readFileSync(join(fixture.fakeStateDir, 'terminal-events'), 'utf8').trim().split('\n');
      expect(terminalEvents).toEqual(['terminal']);
      appendOrderedTrace(fixture, 'one terminal and settled row');
      expect(readFileSync(join(fixture.fakeStateDir, 'ordered-trace'), 'utf8').trim().split('\n')).toEqual([
        'second operation durable proxy locator',
        'fake thread/start',
        'durable provider watermark 1 / ACK',
        'fake turn/start',
        'one terminal and settled row',
      ]);

      await waitForCondition(() => readDiscoveryRecord(fixture.home, fixture.flavor) !== null, 10_000);
      discoveryRecord = readDiscoveryRecord(fixture.home, fixture.flavor);

      expect(discoveryRecord).not.toBeNull();
      expect(discoveryRecord !== null && observeProcessLiveness(discoveryRecord.pid) === 'alive').toBe(true);
      expect(discoveryRecord?.socketPath).toContain('.sock');

      const runtime = createRealRuntime('prod');
      const db = openStoreDatabase({
        storeFormat: currentCoralStoreFormat(),
        path: storePaths(fixture.flavor, { baseDir: join(fixture.home, '.coral') }).dbFile,
        storage: runtime.storage,
        readonly: true,
      });

      try {
        const store = new CoralStore(db, createDefaultStoreReadContext());
        const jobs = store.jobs.list({ projectRoot: fixture.projectRoot, all: true });
        expect(jobs).toHaveLength(2);

        for (const jobId of [firstJobId, secondJobId]) {
          const detail = store.jobs.detail(jobId);
          const resultPath = resultArtifactPath(fixture.home, fixture.flavor, jobId);
          expect(detail?.status.phase).toBe('completed');
          expect(detail?.status.result?.content).toBe('scripted terminal output');
          expect(existsSync(resultPath)).toBe(true);
          expect(readFileSync(resultPath, 'utf-8').trimEnd()).toBe('scripted terminal output');
        }
      } finally {
        db.close();
      }
    } finally {
      await shutdownBackend(discoveryRecord ?? readDiscoveryRecord(fixture.home, fixture.flavor));
    }
  }, 120_000);
});
