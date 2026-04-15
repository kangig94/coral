import { spawn as spawnChild } from 'node:child_process';
import { randomBytes as randomBytesNode, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  chmodSync,
  existsSync,
  fdatasyncSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  composeChildEnv,
  parsePassthrough,
  resolveEnvBudgetBytes,
} from '../shared/env-sanitize.js';
import {
  backendInfoPath,
  backendLockPath,
  discussBaseDirForSource,
  discussDiscoveryLockPathForSource,
  discussDiscoveryPathForSource,
  discussEventLogPath,
  discussSessionDirForSource,
  discussSourcesLockPath,
  discussSourcesPath,
  discussStatePath,
  discussSummaryIndexPathForSource,
  jobsDir,
  jobStatusPath,
  pluginRootNamespace,
  resolveProjectSource,
  sessionBase,
} from '../infra/paths.js';
import { isDurableCliRuntime, type DurableCliRuntimeRecord, type PersistedExitRecord } from '../shared/types.js';
import type {
  ChildProcessLike,
  DurableExecutionTransport,
  Runtime,
  RuntimeEnv,
  RuntimeIds,
  RuntimePaths,
  RuntimeProcess,
  RuntimeSpawnMode,
  RuntimeStorage,
  RuntimeTime,
} from '../shared/runtime-ports.js';
export type {
  ChildProcessLike,
  ChildReadableLike,
  ChildStdinLike,
  DiscussPathResolver,
  Disposable,
  DurableExecutionTransport,
  DurableLaunchOptions,
  DurableLaunchResult,
  DurableTransportLike,
  LaunchPool,
  Runtime,
  RuntimeDirentLike,
  RuntimeEnv,
  RuntimeEnvPort,
  RuntimeIds,
  RuntimeIdsPort,
  RuntimeObserver,
  RuntimePaths,
  RuntimePathsPort,
  RuntimeProcess,
  RuntimeProcessPort,
  RuntimeSpawnMode,
  RuntimeSpawnOptions,
  RuntimeStorage,
  RuntimeStoragePort,
  RuntimeTime,
  RuntimeTimePort,
  RuntimeTimerHandle,
  SpawnEvent,
  SpawnListener,
} from '../shared/runtime-ports.js';

const DURABLE_POLL_INTERVAL_MS = 100;
const DURABLE_POLL_TIMEOUT_MS = 5_000;
const DURABLE_EXIT_GRACE_MS = 5_000;
const RUNTIME_RECORD_FILE = 'runtime.json';
const EXIT_RECORD_FILE = 'exit.json';
const ENV_RECORD_FILE = 'env.json';
const WRAPPER_SCRIPT = `
const { spawn } = require('child_process');
const { openSync, closeSync, readFileSync, writeFileSync, renameSync } = require('fs');
const { join } = require('path');

const jobDir = process.argv[1];
const command = process.argv[2];
const args = JSON.parse(process.argv[3]);
const env = JSON.parse(readFileSync(join(jobDir, 'env.json'), 'utf8'));
const cwd = process.argv[4] || undefined;
const prompt = process.argv[5] || '';

const stdoutPath = join(jobDir, 'stdout');
const stderrPath = join(jobDir, 'stderr');

const stdoutFd = openSync(stdoutPath, 'w');
const stderrFd = openSync(stderrPath, 'w');

const child = spawn(command, args, {
  stdio: ['pipe', stdoutFd, stderrFd],
  cwd,
  env,
  shell: process.platform === 'win32',
});

const runtimeRecord = {
  pid: child.pid,
  stdoutPath,
  stderrPath,
  startTime: new Date().toISOString(),
};
const runtimeTmp = join(jobDir, 'runtime.json.tmp');
const runtimeFinal = join(jobDir, 'runtime.json');
writeFileSync(runtimeTmp, JSON.stringify(runtimeRecord, null, 2));
renameSync(runtimeTmp, runtimeFinal);

if (prompt) child.stdin.write(prompt);
child.stdin.end();

function writeExit(code, signal, exitCode) {
  try { closeSync(stdoutFd); } catch {}
  try { closeSync(stderrFd); } catch {}
  const exitRecord = { exitCode: code, signal: signal || null, endTime: new Date().toISOString() };
  const exitTmp = join(jobDir, 'exit.json.tmp');
  const exitFinal = join(jobDir, 'exit.json');
  writeFileSync(exitTmp, JSON.stringify(exitRecord, null, 2));
  renameSync(exitTmp, exitFinal);
  process.exit(exitCode);
}

child.on('close', (code, signal) => writeExit(code, signal, 0));
child.on('error', () => writeExit(null, null, 1));
`.trim();

type CapturedEnvState = {
  fullEnv: Readonly<Record<string, string>>;
  coralEnv: Readonly<Record<string, string>>;
  pid: number;
  platform: NodeJS.Platform;
  cwd: string;
};

export function createRealRuntime(): Runtime {
  const capturedEnv = captureEnvState();
  const envBudgetBytes = resolveEnvBudgetBytes();
  const envPassthrough = parsePassthrough(capturedEnv.coralEnv.CORAL_ENV_PASSTHROUGH);
  const time: RuntimeTime = {
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      if (handle) clearTimeout(handle as NodeJS.Timeout);
    },
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => {
      if (handle) clearInterval(handle as NodeJS.Timeout);
    },
  };

  const storage: RuntimeStorage = {
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    mkdirSync: (path, options) => mkdirSync(path, options),
    rmSync: (path, options) => rmSync(path, options),
    readdirSync: (path, options) => readdirSync(path, options),
    statSync: (path) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: () => stats.isDirectory(),
        isFile: () => stats.isFile(),
      };
    },
    existsSync: (path) => existsSync(path),
    openSync: (path, flags) => openSync(path, flags),
    readSync: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    closeSync: (fd) => closeSync(fd),
    appendFileSync: (path, data) => appendFileSync(path, data),
    appendFileDurableSync: (path, data) => appendFileDurableSyncNode(path, data),
    unlinkSync: (path) => unlinkSync(path),
    tryExclusiveWriteSync: (path, data, options) => tryExclusiveWriteSyncNode(path, data, capturedEnv.platform, options),
    writeAtomicSync: (path, data, options) => writeAtomicSyncNode(path, data, options),
    writeAtomicDurableSync: (path, data, options) => writeAtomicDurableSyncNode(path, data, options),
    chmodSync: (path, mode) => chmodSync(path, mode),
  };

  const paths: RuntimePaths = {
    jobsDir,
    jobStatusPath,
    sessionBase,
    backendInfoPath,
    backendLockPath,
    pluginRootNamespace,
    projectSource: resolveProjectSource,
    discussSourcesPath,
    discussSourcesLockPath,
    discussBaseDirForSource,
    discussDiscoveryPathForSource,
    discussDiscoveryLockPathForSource,
    discussSummaryIndexPathForSource,
    discussSessionDirForSource,
    discussStatePath,
    discussEventLogPath,
  };

  const buildSpawnEnv = (envAdditions?: Record<string, string>): Record<string, string> => {
    return composeChildEnv(
      { ...capturedEnv.fullEnv },
      envAdditions ?? {},
      envBudgetBytes,
      envPassthrough,
    );
  };

  const durable: DurableExecutionTransport = {
    launch: async (options) => {
      const runtimePath = `${options.jobDir}/${RUNTIME_RECORD_FILE}`;
      const envPath = `${options.jobDir}/${ENV_RECORD_FILE}`;
      writeAtomicJson(storage, envPath, buildSpawnEnv(options.envAdditions));

      const wrapper = spawnChild(
        process.execPath,
        ['-e', WRAPPER_SCRIPT, options.jobDir, options.command, JSON.stringify(options.args), options.cwd ?? '', options.prompt ?? ''],
        {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: buildSpawnEnv(),
        },
      );
      wrapper.unref();

      const runtimeRecord = await waitForRuntimeRecord({
        storage,
        time,
        process: { isAlive: processIsAlive },
        runtimePath,
        pid: wrapper.pid,
      });

      return {
        pid: runtimeRecord.pid,
        stdoutPath: runtimeRecord.stdoutPath,
        stderrPath: runtimeRecord.stderrPath,
        runtimeRecord,
      };
    },
    waitForExit: async (handle) => {
      const exitPath = `${dirname(handle.runtimeRecord.stdoutPath)}/${EXIT_RECORD_FILE}`;
      let exitedAt: number | null = null;

      while (true) {
        const record = readJsonIfPresent<PersistedExitRecord>(storage, exitPath);
        if (record) {
          return record;
        }

        if (!processIsAlive(handle.pid)) {
          exitedAt ??= time.now();
          if (time.now() - exitedAt >= DURABLE_EXIT_GRACE_MS) {
            throw new Error(`Durable process ${handle.pid} exited before ${EXIT_RECORD_FILE} was written`);
          }
        } else {
          exitedAt = null;
        }

        await time.sleep(DURABLE_POLL_INTERVAL_MS);
      }
    },
  };

  const runtimeProcess: RuntimeProcess = {
    spawn: (options) => {
      const spawnEnv = buildSpawnEnv(options.envAdditions);
      const child = spawnChild(options.command, options.args, {
        stdio: toNodeStdio(options.mode),
        cwd: options.cwd,
        shell: options.shell,
        env: spawnEnv,
        detached: options.mode === 'detached',
      });
      const runtimeChild = child as unknown as ChildProcessLike;
      return runtimeChild;
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        /* already dead */
      }
    },
    isAlive: (pid) => processIsAlive(pid),
    durable,
  };

  const ids: RuntimeIds = {
    uuid: () => randomUUID(),
    randomBytes: (size) => randomBytesNode(size),
  };

  const env: RuntimeEnv = {
    get: (key) => capturedEnv.fullEnv[key],
    pid: () => capturedEnv.pid,
    platform: () => capturedEnv.platform,
    cwd: () => capturedEnv.cwd,
    coralSnapshot: () => capturedEnv.coralEnv,
  };

  return {
    time,
    storage,
    process: runtimeProcess,
    ids,
    env,
    paths,
  };
}

function captureEnvState(): CapturedEnvState {
  const fullEnv: Record<string, string> = {};
  const coralEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue;
    fullEnv[key] = value;
    if (key.startsWith('CORAL_')) {
      coralEnv[key] = value;
    }
  }

  return {
    fullEnv: Object.freeze({ ...fullEnv }),
    coralEnv: Object.freeze(coralEnv),
    pid: process.pid,
    platform: process.platform,
    cwd: process.cwd(),
  };
}

function toNodeStdio(mode: RuntimeSpawnMode): ['pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'] {
  if (mode === 'piped') {
    return ['pipe', 'pipe', 'pipe'];
  }
  return ['ignore', 'ignore', 'ignore'];
}

function writeAtomicJson(storage: RuntimeStorage, path: string, value: unknown): void {
  storage.writeAtomicSync(path, JSON.stringify(value));
}

async function waitForRuntimeRecord(options: {
  storage: RuntimeStorage;
  time: RuntimeTime;
  process: Pick<RuntimeProcess, 'isAlive'>;
  runtimePath: string;
  pid: number | undefined;
}): Promise<DurableCliRuntimeRecord> {
  const deadline = options.time.now() + DURABLE_POLL_TIMEOUT_MS;

  while (options.time.now() < deadline) {
    const record = readJsonIfPresent<DurableCliRuntimeRecord>(options.storage, options.runtimePath);
    if (record && isDurableCliRuntime(record)) {
      return record;
    }

    if (options.pid !== undefined && !options.process.isAlive(options.pid)) {
      break;
    }

    await options.time.sleep(DURABLE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Durable wrapper failed to write ${RUNTIME_RECORD_FILE} within ${DURABLE_POLL_TIMEOUT_MS}ms (${options.runtimePath})`,
  );
}

function readJsonIfPresent<T>(storage: RuntimeStorage, path: string): T | null {
  if (!storage.existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(storage.readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err) {
      if ((err as { code: string }).code === 'EPERM') return true;
      if ((err as { code: string }).code === 'ESRCH') return false;
    }
    return false;
  }
}

function tryExclusiveWriteSyncNode(
  path: string,
  data: string,
  platform: NodeJS.Platform,
  options?: { encoding?: BufferEncoding; mode?: number },
): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const encoding = options?.encoding ?? 'utf-8';
  const mode = options?.mode ?? 0o600;
  try {
    writeFileSync(path, data, { encoding, mode, flag: 'wx' });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
  if (platform !== 'win32') {
    try {
      chmodSync(path, mode);
    } catch {
      /* best effort */
    }
  }
  return true;
}

function writeAtomicSyncNode(
  path: string,
  data: string,
  options?: { encoding?: BufferEncoding; mode?: number },
): boolean {
  const encoding = options?.encoding ?? 'utf-8';
  const mode = options?.mode;
  const tempPath = `${path}.tmp`;
  try {
    writeFileSync(tempPath, data, mode === undefined ? { encoding } : { encoding, mode });
    renameSync(tempPath, path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function writeAtomicDurableSyncNode(
  path: string,
  data: string,
  options?: { encoding?: BufferEncoding; mode?: number },
): boolean {
  const encoding = options?.encoding ?? 'utf-8';
  const mode = options?.mode;
  const parent = dirname(path);
  const tempPath = `${path}.tmp`;
  mkdirSync(parent, { recursive: true });

  let fd: number | null = null;
  try {
    fd = mode === undefined ? openSync(tempPath, 'w') : openSync(tempPath, 'w', mode);
    writeAllSync(fd, Buffer.from(data, encoding));
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
    syncParentDirectoryBestEffort(parent);
    return true;
  } catch (error: unknown) {
    if (fd !== null) {
      closeSync(fd);
    }
    try {
      unlinkSync(tempPath);
    } catch {
      /* best effort */
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function appendFileDurableSyncNode(path: string, data: string): boolean {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });

  let fd: number | null = null;
  try {
    fd = openSync(path, 'a');
    writeAllSync(fd, Buffer.from(data, 'utf-8'));
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    return true;
  } catch (error: unknown) {
    if (fd !== null) {
      closeSync(fd);
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function writeAllSync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

// Directory fsync after rename is best-effort because not every platform/filesystem supports opening directories.
function syncParentDirectoryBestEffort(parent: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = openSync(parent, 'r');
    fsyncSync(dirFd);
  } catch {
    /* best effort */
  } finally {
    if (dirFd !== null) {
      try {
        closeSync(dirFd);
      } catch {
        /* best effort */
      }
    }
  }
}
