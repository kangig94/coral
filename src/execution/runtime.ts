import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHash, randomBytes as randomBytesNode, randomUUID } from 'node:crypto';
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
import { homedir as osHomedir } from 'node:os';
import { dirname } from 'node:path';
import {
  composeChildEnv,
  parsePassthrough,
  resolveEnvBudgetBytes,
} from '../shared/env-sanitize.js';
import { MAX_BUFFER, SIGTERM_GRACE_MS } from '../shared/process-constants.js';
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
  installationDirForNamespace,
  pluginRootNamespace,
  resolveProjectSource,
  sessionBase,
} from '../infra/paths.js';
import { isDurableCliRuntime, type DurableCliRuntimeRecord, type PersistedExitRecord } from '../shared/types.js';
import type {
  ChildProcessLike,
  DurableExecutionTransport,
  ExecResult,
  Runtime,
  RuntimeEnv,
  RuntimeExecOptions,
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
  ExecResult,
  LaunchPool,
  Runtime,
  RuntimeDirentLike,
  RuntimeEnv,
  RuntimeEnvPort,
  RuntimeExecOptions,
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
    installationDirForNamespace,
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

  const resolveExecEnv = (options: RuntimeExecOptions = {}): Record<string, string> => {
    if (options.inheritEnv) {
      return {
        ...capturedEnv.fullEnv,
        ...(options.env ?? {}),
      };
    }
    return buildSpawnEnv(options.env);
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

  const runtimeProcess = {
    spawn: (options) => {
      const spawnEnv =
        options.inheritEnv || options.env
          ? resolveExecEnv({
              env: options.env ?? options.envAdditions,
              inheritEnv: options.inheritEnv,
            })
          : buildSpawnEnv(options.envAdditions);
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
  } as RuntimeProcess;

  runtimeProcess.exec = (command, args, options = {}) => {
    const execOptions: RuntimeExecOptions = { ...options };
    execOptions.maxBuffer ??= MAX_BUFFER;
    const maxBuffer = execOptions.maxBuffer;
    const encoding = execOptions.encoding ?? 'utf-8';

    return new Promise<ExecResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let resolved = false;
      let timeoutHandle: ReturnType<RuntimeTime['setTimeout']> | null = null;
      let killTimer: ReturnType<RuntimeTime['setTimeout']> | null = null;
      let wrapperKilled: 'timeout' | 'maxBuffer' | null = null;

      const child = runtimeProcess.spawn({
        command,
        args,
        cwd: execOptions.cwd,
        env: execOptions.env,
        inheritEnv: execOptions.inheritEnv,
        mode: 'piped',
      });

      child.stdin?.end();

      const clearTimers = (): void => {
        time.clearTimeout(timeoutHandle);
        timeoutHandle = null;
        time.clearTimeout(killTimer);
        killTimer = null;
      };

      const finish = (result: ExecResult): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        clearTimers();
        resolve(result);
      };

      const scheduleKill = (reason: 'timeout' | 'maxBuffer'): void => {
        if (resolved || wrapperKilled !== null || child.pid === undefined) {
          return;
        }
        wrapperKilled = reason;
        runtimeProcess.kill(child.pid, 'SIGTERM');
        killTimer = time.setTimeout(() => {
          if (resolved || child.pid === undefined) {
            return;
          }
          runtimeProcess.kill(child.pid, 'SIGKILL');
        }, SIGTERM_GRACE_MS);
        killTimer.unref?.();
      };

      const appendOutput = (
        current: string,
        chunk: string | Buffer,
      ): { next: string; overflowed: boolean } => {
        if (wrapperKilled !== null) {
          return { next: current, overflowed: false };
        }

        const text = typeof chunk === 'string' ? chunk : chunk.toString(encoding);
        const currentBytes = Buffer.byteLength(current, encoding);
        const chunkBytes = Buffer.byteLength(text, encoding);
        if (currentBytes + chunkBytes <= maxBuffer) {
          return { next: current + text, overflowed: false };
        }

        let next = current;
        let remainingBytes = maxBuffer - currentBytes;
        if (remainingBytes > 0) {
          for (const character of text) {
            const characterBytes = Buffer.byteLength(character, encoding);
            if (characterBytes > remainingBytes) {
              break;
            }
            next += character;
            remainingBytes -= characterBytes;
          }
        }
        return { next, overflowed: true };
      };

      if (child.stdout) {
        child.stdout.setEncoding(encoding);
        child.stdout.on('data', (chunk) => {
          const result = appendOutput(stdout, chunk);
          stdout = result.next;
          if (result.overflowed) {
            scheduleKill('maxBuffer');
          }
        });
      }

      if (child.stderr) {
        child.stderr.setEncoding(encoding);
        child.stderr.on('data', (chunk) => {
          const result = appendOutput(stderr, chunk);
          stderr = result.next;
          if (result.overflowed) {
            scheduleKill('maxBuffer');
          }
        });
      }

      child.on('close', (status) => {
        const error =
          wrapperKilled === 'timeout'
            ? new Error(`timeout: ${command}`)
            : wrapperKilled === 'maxBuffer'
              ? new Error(`maxBuffer exceeded: ${command}`)
              : undefined;
        finish({
          stdout,
          stderr,
          status: error ? null : status,
          ...(error ? { error } : {}),
        });
      });

      child.on('error', (error) => {
        finish({
          stdout: '',
          stderr: '',
          status: null,
          error,
        });
      });

      if (execOptions.timeout !== undefined) {
        timeoutHandle = time.setTimeout(() => {
          scheduleKill('timeout');
        }, execOptions.timeout);
        timeoutHandle.unref?.();
      }
    });
  };

  runtimeProcess.execSync = (command, args, options = {}) => {
    const execOptions: RuntimeExecOptions = { ...options };
    execOptions.maxBuffer ??= MAX_BUFFER;
    const encoding = execOptions.encoding ?? 'utf-8';
    const maxBuffer = execOptions.maxBuffer;
    const spawnOptions = {
      cwd: execOptions.cwd,
      env: resolveExecEnv(execOptions),
      timeout: execOptions.timeout,
      encoding,
      maxBuffer,
      shell: false,
      stdio: 'pipe' as const,
    };

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(command, args, spawnOptions);
    } catch (error: unknown) {
      if (isSpawnFailure(error)) {
        return {
          stdout: '',
          stderr: '',
          status: null,
          error,
        };
      }
      throw error;
    }

    const stdout = normalizeSpawnSyncOutput(result.stdout, encoding);
    const stderr = normalizeSpawnSyncOutput(result.stderr, encoding);

    if (result.error) {
      const hasOutput = stdout.length > 0 || stderr.length > 0;
      const errorCode = (result.error as NodeJS.ErrnoException).code;
      if (errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || (hasOutput && result.signal === null)) {
        return {
          stdout,
          stderr,
          status: null,
          error: new Error(`maxBuffer exceeded: ${command}`),
        };
      }
      if (result.signal) {
        return {
          stdout,
          stderr,
          status: null,
          error: new Error(`timeout: ${command}`),
        };
      }
      return {
        stdout: '',
        stderr: '',
        status: null,
        error: result.error,
      };
    }

    if (result.signal) {
      return {
        stdout,
        stderr,
        status: null,
        error: new Error(`timeout: ${command}`),
      };
    }

    return {
      stdout,
      stderr,
      status: result.status,
    };
  };

  const ids: RuntimeIds = {
    uuid: () => randomUUID(),
    randomBytes: (size) => randomBytesNode(size),
    sha256: (input) => createHash('sha256').update(input).digest('hex'),
  };

  const env: RuntimeEnv = {
    get: (key) => capturedEnv.fullEnv[key],
    homedir: () => osHomedir(),
    pid: () => capturedEnv.pid,
    platform: () => capturedEnv.platform,
    cwd: () => capturedEnv.cwd,
    fullSnapshot: () => capturedEnv.fullEnv,
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

function normalizeSpawnSyncOutput(
  output: string | Buffer | null | undefined,
  encoding: BufferEncoding,
): string {
  if (typeof output === 'string') {
    return output;
  }
  if (!output) {
    return '';
  }
  return output.toString(encoding);
}

function isSpawnFailure(error: unknown): error is Error & { code?: string } {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code !== undefined &&
    (error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  );
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
