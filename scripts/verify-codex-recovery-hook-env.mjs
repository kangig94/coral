#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const CHILD_KEYS = ['CORAL_CHILD', 'CORAL_CHILD_PRINCIPAL_HANDLE', 'CORAL_JOB_ID', 'CORAL_SESSION_ID'];
const SAFE_BASE_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
];
const RPC_TIMEOUT_MS = 20_000;
const execFileAsync = promisify(execFile);

function cleanEnvironment(values = {}) {
  const env = {};
  for (const key of SAFE_BASE_ENV_KEYS) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  Object.assign(env, values);
  for (const key of CHILD_KEYS) {
    if (!Object.hasOwn(values, key)) delete env[key];
  }
  return env;
}

function quoteShell(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function rejectPendingRequests(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

function settleRpcFrame(line, pending, state) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) {
    entry.reject(new Error(`codex RPC failed: ${JSON.stringify(message.error)}\n${state.stderr}`));
  } else {
    entry.resolve(message.result);
  }
}

function createRpcRequest({ pending, send, state, id, method, params }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timed out waiting for ${method}\n${state.stderr}`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      send({ method, id, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function createAppServerRpc(child, lines, state) {
  const pending = new Map();
  let nextId = 1;
  const rejectPending = (error) => rejectPendingRequests(pending, error);
  const send = (message) => {
    if (state.exited || !child.stdin.writable) {
      throw new Error(`codex app-server is not writable\n${state.stderr}`);
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  child.stdin.on('error', (error) => {
    if (!state.exited) {
      rejectPending(new Error(`codex app-server stdin failed: ${error.message}\n${state.stderr}`, { cause: error }));
    }
  });
  lines.on('line', (line) => settleRpcFrame(line, pending, state));

  return {
    rejectPending,
    rpc: (method, params) => createRpcRequest({ pending, send, state, id: nextId++, method, params }),
    send,
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function attachAppServerLifecycle(child, state, spawned, exited, rejectPending) {
  let spawnSettled = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
  });
  child.once('spawn', () => {
    spawnSettled = true;
    spawned.resolve();
  });
  child.once('error', (error) => {
    const startFailed = !spawnSettled;
    if (startFailed) {
      spawnSettled = true;
      spawned.reject(new Error(`failed to start codex app-server: ${error.message}`, { cause: error }));
    }
    rejectPending(new Error(`codex app-server process error: ${error.message}\n${state.stderr}`, { cause: error }));
    if (startFailed && !state.exited) {
      state.exited = true;
      exited.resolve();
    }
  });
  child.once('exit', (code, signal) => {
    state.exited = true;
    const detail = `codex app-server exited before replying (code=${String(code)}, signal=${String(signal)})`;
    rejectPending(new Error(`${detail}\n${state.stderr}`));
    exited.resolve();
  });
}

function waitForAppServerExit(state, exitedPromise, timeoutMs) {
  if (state.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void exitedPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function closeAppServer(child, lines, state, exitedPromise) {
  const waitForExit = (timeoutMs) => waitForAppServerExit(state, exitedPromise, timeoutMs);
  if (!state.exited) {
    child.stdin.end();
    if (!(await waitForExit(1_000))) child.kill('SIGTERM');
    if (!(await waitForExit(2_000))) child.kill('SIGKILL');
    if (!(await waitForExit(2_000))) {
      throw new Error(`codex app-server did not exit after SIGKILL\n${state.stderr}`);
    }
  }
  if (!lines.closed) lines.close();
}

function createAppServerLifecycle(child, lines, state, rejectPending) {
  const spawned = createDeferred();
  const exited = createDeferred();
  attachAppServerLifecycle(child, state, spawned, exited, rejectPending);

  return {
    spawned: () => spawned.promise,
    close: () => closeAppServer(child, lines, state, exited.promise),
  };
}

function createAppServer({ home, codexHome, cwd, temp, env = {} }) {
  const child = spawn('codex', ['app-server'], {
    cwd,
    env: cleanEnvironment({
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      NO_COLOR: '1',
      ...env,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const state = { exited: false, stderr: '' };
  const protocol = createAppServerRpc(child, lines, state);
  const lifecycle = createAppServerLifecycle(child, lines, state, protocol.rejectPending);

  return {
    async initialize() {
      await lifecycle.spawned();
      await protocol.rpc('initialize', {
        clientInfo: { name: 'coral-recovery-hook-probe', title: null, version: '1' },
        capabilities: null,
      });
      protocol.send({ method: 'initialized' });
    },
    rpc: protocol.rpc,
    close: lifecycle.close,
  };
}

async function readCodexVersion(env) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('codex', ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 5_000,
    }));
  } catch (error) {
    throw new Error(`unable to run current Codex CLI: ${error instanceof Error ? error.message : String(error)}`);
  }
  const version = stdout.trim();
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  const supported = match !== null && (Number(match[1]) > 0 || Number(match[2]) >= 146);
  if (!supported) {
    throw new Error(`Codex recovery hook probe requires codex-cli >= 0.146.0; found ${version || 'unknown'}`);
  }
  return version;
}

async function waitForRecords(path, expectedCount) {
  const deadline = Date.now() + RPC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const records = (await readFile(path, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (records.length >= expectedCount) return records;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${expectedCount} Codex hook record(s)`);
}

function assertHookRecord(record, scenario, expectedChild) {
  if (record.scenario !== scenario) {
    throw new Error(`unexpected hook scenario: ${JSON.stringify(record)}`);
  }
  if (record.source !== 'resume' || record.event !== 'SessionStart') {
    throw new Error(`unexpected hook event: ${JSON.stringify(record)}`);
  }
  if (record.child !== expectedChild) {
    throw new Error(`unexpected CORAL_CHILD value for ${scenario}: ${JSON.stringify(record)}`);
  }
  for (const key of ['handle', 'jobId', 'sessionId']) {
    if (record[key] !== null) {
      throw new Error(`child credential leaked through ${key} for ${scenario}: ${JSON.stringify(record)}`);
    }
  }
}

async function resumeThread({
  home,
  codexHome,
  cwd,
  temp,
  threadId,
  scenario,
  hostMarker,
  config,
  recordsPath,
  expectedRecordCount,
}) {
  const server = createAppServer({
    home,
    codexHome,
    cwd,
    temp,
    env: {
      CORAL_PROBE_SCENARIO: scenario,
      ...(hostMarker ? { CORAL_CHILD: '1' } : {}),
    },
  });
  try {
    await server.initialize();
    const hookListing = await server.rpc('hooks/list', { cwds: [cwd] });
    const sessionStartHook = hookListing?.data
      ?.flatMap((entry) => entry.hooks ?? [])
      .find((hook) => hook.eventName === 'sessionStart');
    if (!sessionStartHook?.enabled || sessionStartHook.trustStatus !== 'trusted') {
      throw new Error(`Codex did not load the probe SessionStart hook: ${JSON.stringify(hookListing)}`);
    }
    await server.rpc('thread/resume', {
      threadId,
      cwd,
      model: null,
      modelProvider: 'openai',
      approvalPolicy: 'never',
      config,
    });
    await server.rpc('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Run the Coral recovery hook probe.', text_elements: [] }],
    });
    return await waitForRecords(recordsPath, expectedRecordCount);
  } finally {
    await server.close();
  }
}

const fixture = await mkdtemp(join(tmpdir(), 'coral-codex-hook-probe-'));
const home = join(fixture, 'home');
const codexHome = join(home, '.codex');
const cwd = join(fixture, 'workspace');
const temp = join(fixture, 'tmp');
const hookPath = join(fixture, 'record-hook.mjs');
const recordsPath = join(fixture, 'hook-records.jsonl');
const configPath = join(codexHome, 'config.toml');

try {
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(temp, { recursive: true }),
  ]);
  const codexVersion = await readCodexVersion(
    cleanEnvironment({ HOME: home, CODEX_HOME: codexHome, TMPDIR: temp, TMP: temp, TEMP: temp, NO_COLOR: '1' }),
  );
  await writeFile(configPath, `cli_auth_credentials_store = "file"\n`);
  await writeFile(
    hookPath,
    `import { appendFileSync } from 'node:fs';\n` +
      `let input = '';\n` +
      `for await (const chunk of process.stdin) input += chunk;\n` +
      `const payload = JSON.parse(input);\n` +
      `appendFileSync(process.argv[2], JSON.stringify({\n` +
      `  scenario: process.env.CORAL_PROBE_SCENARIO ?? null,\n` +
      `  event: payload.hook_event_name ?? null,\n` +
      `  source: payload.source ?? null,\n` +
      `  child: process.env.CORAL_CHILD ?? null,\n` +
      `  handle: process.env.CORAL_CHILD_PRINCIPAL_HANDLE ?? null,\n` +
      `  jobId: process.env.CORAL_JOB_ID ?? null,\n` +
      `  sessionId: process.env.CORAL_SESSION_ID ?? null,\n` +
      `}) + '\\n');\n`,
  );
  await writeFile(
    join(codexHome, 'hooks.json'),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `${quoteShell(process.execPath)} ${quoteShell(hookPath)} ${quoteShell(recordsPath)}`,
                  timeout: 10,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );

  const inspector = createAppServer({ home, codexHome, cwd, temp });
  let hookMetadata;
  try {
    await inspector.initialize();
    const listing = await inspector.rpc('hooks/list', { cwds: [cwd] });
    hookMetadata = listing?.data
      ?.flatMap((entry) => entry.hooks ?? [])
      .find((hook) => hook.eventName === 'sessionStart');
    if (typeof hookMetadata?.key !== 'string' || typeof hookMetadata?.currentHash !== 'string') {
      throw new Error(`Codex did not discover the probe SessionStart hook: ${JSON.stringify(listing)}`);
    }
  } finally {
    await inspector.close();
  }
  await writeFile(
    configPath,
    `cli_auth_credentials_store = "file"\n\n` +
      `[hooks.state.${JSON.stringify(hookMetadata.key)}]\n` +
      `enabled = true\n` +
      `trusted_hash = ${JSON.stringify(hookMetadata.currentHash)}\n`,
  );

  const starter = createAppServer({ home, codexHome, cwd, temp });
  let threadId;
  try {
    await starter.initialize();
    const response = await starter.rpc('thread/start', {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: false,
      config: { mcp_servers: {} },
    });
    threadId = response?.thread?.id;
    if (typeof threadId !== 'string' || threadId.length === 0) {
      throw new Error(`Codex did not return a thread id: ${JSON.stringify(response)}`);
    }
    await starter.rpc('thread/inject_items', {
      threadId,
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Coral recovery hook probe.' }],
        },
      ],
    });
  } finally {
    await starter.close();
  }
  await rm(recordsPath, { force: true });

  let records = await resumeThread({
    home,
    codexHome,
    cwd,
    temp,
    threadId,
    scenario: 'thread-policy-only-negative-control',
    hostMarker: false,
    config: {
      shell_environment_policy: { inherit: 'all', set: { CORAL_CHILD: '1' } },
    },
    recordsPath,
    expectedRecordCount: 1,
  });
  assertHookRecord(records[0], 'thread-policy-only-negative-control', null);

  records = await resumeThread({
    home,
    codexHome,
    cwd,
    temp,
    threadId,
    scenario: 'production-recovery',
    hostMarker: true,
    config: {
      shell_environment_policy: { inherit: 'all', set: { CORAL_CHILD: '1' } },
    },
    recordsPath,
    expectedRecordCount: 2,
  });
  assertHookRecord(records[1], 'production-recovery', '1');

  process.stdout.write(
    `${codexVersion}: Codex host-to-resume-hook contract verified (thread policy negative control + production recovery).\n`,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
