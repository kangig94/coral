import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { isProcessAlive } from '../dist/infra/node-process.js';
import { createIpcClient } from '../dist/transport/ipc/client.js';

const EVIDENCE_PATH = resolve('provider-proxy-codex-smoke.json');
const CLI_BUNDLE = resolve('clients/build/coral-cli.cjs');
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the release-mode Codex smoke`);
  return value;
}

function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      let value;
      try {
        value = check();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolvePromise(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 1);
    };
    poll();
  });
}

function startCli(projectRoot, home, codexHome, promptPath) {
  const {
    CORAL_CHILD: _coralChild,
    CORAL_CHILD_PRINCIPAL_HANDLE: _childPrincipal,
    CORAL_JOB_ID: _coralJobId,
    CORAL_SESSION_ID: _coralSessionId,
    ...topLevelEnv
  } = process.env;
  const child = spawn(process.execPath, [CLI_BUNDLE, 'codex', '-i', promptPath], {
    cwd: projectRoot,
    env: { ...topLevelEnv, HOME: home, TMPDIR: home, CODEX_HOME: codexHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let status = null;
  let failure = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      failure = new Error('real Codex operation did not complete within 180000ms');
      child.kill('SIGKILL');
    }, 180_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      status = code ?? -1;
      if (failure !== null) reject(failure);
      else resolvePromise(status);
    });
  });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    status: () => status,
    completed,
  };
}

function jobIdFrom(stdout) {
  return stdout.match(/^Provider job (\S+) (?:launch accepted|queued) \(provider session \S+\)$/m)?.[1] ?? null;
}

function readOperation(home, jobId) {
  const path = join(home, '.coral', 'gen2', 'data', 'store', 'store.db');
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const prefix = `provider_operation_saga.v1:record:${jobId}:`;
    const rows = db
      .prepare('SELECT key, value FROM meta WHERE key >= ? AND key < ? ORDER BY key LIMIT 2')
      .all(prefix, `${prefix}\uffff`);
    if (rows.length > 1) throw new Error(`job ${jobId} has more than one live provider operation`);
    const row = rows[0];
    return row === undefined ? null : JSON.parse(row.value);
  } finally {
    db.close();
  }
}

function providerSocketCount(home) {
  const coralRoot = join(home, '.coral');
  if (!existsSync(coralRoot)) return 0;
  return readdirSync(coralRoot, { recursive: true }).filter(
    (entry) => typeof entry === 'string' && entry.includes('provider-') && entry.endsWith('.sock'),
  ).length;
}

function requireCompleteLiveLocator(operation) {
  const locator = operation.locator;
  const locatorKeys = Object.keys(locator).sort();
  const expectedKeys = ['containment', 'guardian', 'hostFingerprint', 'proxy', 'reaper'];
  if (JSON.stringify(locatorKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('second operation durable locator is incomplete');
  }
  if (operation.operation.proxyInstanceId !== locator.proxy.instanceId) {
    throw new Error('second operation identity does not name its durable proxy locator');
  }
  if (
    locator.containment.pid !== locator.proxy.pid ||
    locator.containment.processStartedAtSeconds !== locator.proxy.processStartedAtSeconds
  ) {
    throw new Error('second operation containment identity does not name its durable proxy');
  }
  for (const role of ['proxy', 'guardian', 'reaper']) {
    if (!isProcessAlive(locator[role].pid)) {
      throw new Error(`second operation ${role} process is not live`);
    }
  }
}

async function shutdownCoordinator(home) {
  const infoPath = join(home, '.coral', 'gen2', 'run', 'coordinator.json');
  if (!existsSync(infoPath)) return;
  const record = JSON.parse(readFileSync(infoPath, 'utf8'));
  if (!isProcessAlive(record.pid)) return;
  await createIpcClient(record.socketPath, undefined, { kind: 'boot', token: record.bootToken }).shutdown({
    timeoutMs: 5_000,
  });
  await waitFor(() => !isProcessAlive(record.pid), 10_000, 'smoke coordinator shutdown');
}

async function startOperation(projectRoot, home, codexHome, promptPath) {
  const run = startCli(projectRoot, home, codexHome, promptPath);
  const jobId = await waitFor(() => jobIdFrom(run.stdout()), 30_000, 'provider job id');
  return { run, jobId };
}

async function main() {
  if (process.env.CORAL_REQUIRE_CODEX_SMOKE !== '1') {
    throw new Error('CORAL_REQUIRE_CODEX_SMOKE=1 is required; release evidence may never be produced by a skip');
  }
  if (existsSync(EVIDENCE_PATH)) throw new Error('Refusing to overwrite pre-existing Codex smoke evidence');
  if (!existsSync(CLI_BUNDLE)) throw new Error('Run npm run build before the Codex smoke');
  const codexVersion = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (codexVersion.status !== 0) throw new Error('The protected runner has no working Codex binary');
  const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'));
  if (!existsSync(join(codexHome, 'auth.json'))) throw new Error('The protected runner has no Codex credentials');

  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const headSha = requiredEnvironment('CORAL_SMOKE_HEAD_SHA');
  const workflowRunId = Number(requiredEnvironment('GITHUB_RUN_ID'));
  if (!FULL_GIT_SHA.test(headSha)) throw new Error('CORAL_SMOKE_HEAD_SHA must be the exact full Git SHA');
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) throw new Error('GITHUB_RUN_ID must be positive');
  const checkoutSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (checkoutSha !== headSha) throw new Error('Smoke checkout does not match CORAL_SMOKE_HEAD_SHA');

  const root = mkdtempSync(join(tmpdir(), 'coral-real-codex-smoke-'));
  const home = join(root, 'home');
  const projectRoot = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const firstPrompt = join(projectRoot, 'first.txt');
  const secondPrompt = join(projectRoot, 'second.txt');
  writeFileSync(firstPrompt, 'Reply with the single word first.');
  writeFileSync(secondPrompt, 'Reply with the single word second.');

  const trace = [];
  try {
    const first = await startOperation(projectRoot, home, codexHome, firstPrompt);
    const firstStatus = await first.run.completed;
    if (firstStatus !== 0) {
      throw new Error(`first real Codex command failed\n${first.run.stdout()}\n${first.run.stderr()}`);
    }
    trace.push({ event: 'first-operation-completed' });
    await waitFor(() => providerSocketCount(home) >= 3, 30_000, 'discovered provider proxy set');

    const second = await startOperation(projectRoot, home, codexHome, secondPrompt);
    const secondOperation = await waitFor(
      () => readOperation(home, second.jobId),
      30_000,
      `durable provider operation ${second.jobId}`,
    );
    requireCompleteLiveLocator(secondOperation);
    trace.push({ event: 'second-operation-proxy-routed', locator: secondOperation.locator });

    await waitFor(
      () => {
        const record = readOperation(home, second.jobId);
        if (record !== null && (record.phase === 'executing' || record.phase === 'settlement-pending')) {
          if (record.committedThroughProviderSeq === 1) return true;
          if (record.committedThroughProviderSeq > 1) {
            throw new Error(
              `second operation advanced to provider watermark ${record.committedThroughProviderSeq} before exact watermark 1 was observed`,
            );
          }
        }
        return false;
      },
      30_000,
      'exact durable provider watermark 1',
    );
    trace.push({ event: 'durable-watermark-1' });

    let secondStatus;
    try {
      secondStatus = await second.run.completed;
    } catch (error) {
      if (!second.run.stdout().includes('Thread ready (')) {
        throw new Error(
          'real thread/start reached and Coral watermark 1, but turn/start did not follow the durable ACK',
          { cause: error },
        );
      }
      throw error;
    }
    if (secondStatus !== 0) {
      throw new Error(`second real Codex command failed\n${second.run.stdout()}\n${second.run.stderr()}`);
    }
    if (!second.run.stdout().includes('Thread ready (')) {
      throw new Error('real Codex turn did not start after durable continuity ACK');
    }
    await waitFor(() => readOperation(home, second.jobId) === null, 10_000, 'second operation settlement');
    trace.push({ event: 'turn-start-after-ack' });
    trace.push({ event: 'second-operation-settled' });

    const traceSha256 = createHash('sha256').update(JSON.stringify(trace)).digest('hex');
    const evidence = {
      schemaVersion: 1,
      repository,
      headSha,
      workflowRunId,
      provider: 'codex',
      result: 'passed',
      secondOperationProxyRouted: true,
      committedThroughProviderSeq: 1,
      turnStartAfterAck: true,
      traceSha256,
    };
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`real provider proxy Codex smoke passed (${traceSha256})\n`);
  } finally {
    await shutdownCoordinator(home).catch((error) => {
      process.stderr.write(
        `Codex smoke coordinator shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }
}

await main();
