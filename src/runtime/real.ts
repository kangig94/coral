import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHash, randomBytes as randomBytesNode, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
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
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname } from 'node:path';
import { composeCoralPaths } from '../infra/coral-paths.js';
import { resolveProjectSource } from "../infra/project-source.js";
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { CoralPaths } from '../infra/coral-paths.js';
import type {
  ChildProcessLike,
  DurableExecutionTransport,
  EnvPort,
  IdPort,
  ProcessPort,
  Runtime,
  RuntimeExecOptions,
  RuntimePaths,
  RuntimeSpawnMode,
  StorageData,
  StoragePort,
  TimePort,
} from './ports.js';
import { MAX_BUFFER } from '../infra/process-constants.js';
import { composeChildEnv, parsePassthrough, resolveEnvBudgetBytes } from '../infra/env-sanitize.js';
import { isDurableCliRuntime } from './durable-runtime.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from './durable-runtime.js';
import { buildExecPromise } from './exec-builder.js';

const DURABLE_POLL_INTERVAL_MS = 100;
const DURABLE_POLL_TIMEOUT_MS = 5_000;
const DURABLE_EXIT_GRACE_MS = 5_000;
const ENV_RECORD_FILE = 'env.json';
const WRAPPER_SCRIPT = `
const { spawn } = require('child_process');
const { openSync, closeSync, readFileSync } = require('fs');
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
process.stdout.write(JSON.stringify({ type: 'runtime', runtimeRecord }) + '\\n');

if (prompt) child.stdin.write(prompt);
child.stdin.end();

function writeExit(code, signal, exitCode) {
  try { closeSync(stdoutFd); } catch {}
  try { closeSync(stderrFd); } catch {}
  const exitRecord = { exitCode: code, signal: signal || null, endTime: new Date().toISOString() };
  process.stdout.write(JSON.stringify({ type: 'exit', exitRecord }) + '\\n');
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

type DurableControlMessage =
  | {
      type: 'runtime';
      runtimeRecord: DurableCliRuntimeRecord;
    }
  | {
      type: 'exit';
      exitRecord: DurableProcessExit;
    };

export function createRealRuntime(flavor: BuildFlavor): Runtime {
  const capturedEnv = captureEnvState();
  const envBudgetBytes = resolveEnvBudgetBytes();
  const envPassthrough = parsePassthrough(capturedEnv.coralEnv.CORAL_ENV_PASSTHROUGH);
  const time: TimePort = {
    now: () => Date.now(),
    sleep: (ms, options) =>
      new Promise<void>((resolve) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        timer.unref?.();
        const onAbort = (): void => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
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

  const storage: StoragePort = {
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
    tryExclusiveWriteSync: (path, data, options) =>
      tryExclusiveWriteSyncNode(path, data, capturedEnv.platform, options),
    writeAtomicSync: (path, data, options) => writeAtomicSyncNode(path, data, options),
    writeAtomicDurableSync: (path, data, options) => writeAtomicDurableSyncNode(path, data, options),
    chmodSync: (path, mode) => chmodSync(path, mode),
  };

  // CoralPaths is composed on each access so tests can mock node:os.homedir()
  // per-test (in beforeEach) and still get the right roots back from a
  // module-level Runtime instance. Path joins are cheap enough that
  // recomputing per access is fine; caching here would freeze the very first
  // mocked homedir into every subsequent test.
  const paths: RuntimePaths = {
    projectSource: resolveProjectSource,
    get coral(): CoralPaths {
      return composeCoralPaths(flavor);
    },
  };

  const buildSpawnEnv = (envAdditions?: Record<string, string>): Record<string, string> => {
    return composeChildEnv(capturedEnv.fullEnv, envAdditions ?? {}, envBudgetBytes, envPassthrough);
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

  const durableExitPromises = new Map<number, Promise<DurableProcessExit>>();
  const durable: DurableExecutionTransport = {
    launch: async (options) => {
      const envPath = `${options.jobDir}/${ENV_RECORD_FILE}`;
      writeAtomicJson(storage, envPath, buildSpawnEnv(options.envAdditions));

      const wrapper = spawnChild(
        process.execPath,
        [
          '-e',
          WRAPPER_SCRIPT,
          options.jobDir,
          options.command,
          JSON.stringify(options.args),
          options.cwd ?? '',
          options.prompt ?? '',
        ],
        {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildSpawnEnv(),
        },
      );
      wrapper.unref();

      const { runtimeRecord, exitPromise } = await waitForDurableRuntime({
        time,
        wrapper,
      });
      durableExitPromises.set(runtimeRecord.pid, exitPromise);

      return {
        pid: runtimeRecord.pid,
        stdoutPath: runtimeRecord.stdoutPath,
        stderrPath: runtimeRecord.stderrPath,
        runtimeRecord,
      };
    },
    waitForExit: async (handle) => {
      const exitPromise = durableExitPromises.get(handle.pid);
      if (!exitPromise) {
        let exitedAt = null as number | null;
        while (true) {
          if (!processIsAlive(handle.pid)) {
            exitedAt ??= time.now();
            if (time.now() - exitedAt >= DURABLE_EXIT_GRACE_MS) {
              throw new Error(`Durable process ${handle.pid} exited before the wrapper reported completion`);
            }
          } else {
            exitedAt = null;
          }

          await time.sleep(DURABLE_POLL_INTERVAL_MS);
          const pending = durableExitPromises.get(handle.pid);
          if (pending) {
            return pending.finally(() => {
              durableExitPromises.delete(handle.pid);
            });
          }
        }
      }

      return exitPromise.finally(() => {
        durableExitPromises.delete(handle.pid);
      });
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
      return child as unknown as ChildProcessLike;
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
  } as ProcessPort;

  runtimeProcess.exec = (command, args, options = {}) => {
    const execOptions: RuntimeExecOptions = { ...options };
    execOptions.maxBuffer ??= MAX_BUFFER;
    return buildExecPromise({
      command,
      args,
      cwd: execOptions.cwd,
      env: execOptions.env,
      inheritEnv: execOptions.inheritEnv,
      timeoutMs: execOptions.timeout,
      maxBuffer: execOptions.maxBuffer,
      encoding: execOptions.encoding ?? 'utf-8',
      spawn: runtimeProcess.spawn,
      kill: runtimeProcess.kill,
      setTimeout: time.setTimeout,
      clearTimeout: time.clearTimeout,
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

  const ids: IdPort = {
    uuid: () => randomUUID(),
    randomBytes: (size) => randomBytesNode(size),
    sha256: (input) => createHash('sha256').update(input).digest('hex'),
  };

  const env: EnvPort = {
    get: (key) => capturedEnv.fullEnv[key],
    homedir: () => osHomedir(),
    pid: () => capturedEnv.pid,
    platform: () => capturedEnv.platform,
    cwd: () => capturedEnv.cwd,
    fullSnapshot: () => capturedEnv.fullEnv,
    coralSnapshot: () => capturedEnv.coralEnv,
  };

  return {
    flavor,
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
    if (typeof value !== 'string') {
      continue;
    }
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

function writeAtomicJson(storage: StoragePort, path: string, value: unknown): void {
  storage.writeAtomicSync(path, JSON.stringify(value));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let settled = false;
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    rejectFn = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
  });
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  };
}

function trimStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? `: ${trimmed}` : '';
}

function isExitRecord(value: unknown): value is DurableProcessExit {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { endTime?: unknown }).endTime === 'string' &&
    ((value as { exitCode?: unknown }).exitCode === null ||
      typeof (value as { exitCode?: unknown }).exitCode === 'number') &&
    ((value as { signal?: unknown }).signal === null || typeof (value as { signal?: unknown }).signal === 'string')
  );
}

function waitForDurableRuntime(options: {
  time: TimePort;
  wrapper: ReturnType<typeof spawnChild>;
}): Promise<{ runtimeRecord: DurableCliRuntimeRecord; exitPromise: Promise<DurableProcessExit> }> {
  const stdout = options.wrapper.stdout;
  const stderr = options.wrapper.stderr;
  if (!stdout || !stderr) {
    throw new Error('Durable wrapper control pipes are unavailable');
  }

  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');

  const runtimeDeferred = createDeferred<DurableCliRuntimeRecord>();
  const exitDeferred = createDeferred<DurableProcessExit>();
  let runtimeRecord: DurableCliRuntimeRecord | null = null;
  let stderrBuffer = '';
  let lineBuffer = '';

  const buildError = (detail: string): Error => new Error(`${detail}${trimStderr(stderrBuffer)}`);

  const handleControlLine = (line: string): void => {
    if (line.trim().length === 0) {
      return;
    }

    let message: DurableControlMessage;
    try {
      message = JSON.parse(line) as DurableControlMessage;
    } catch (error: unknown) {
      const wrapped = buildError(
        `Durable wrapper emitted invalid control JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      runtimeDeferred.reject(wrapped);
      exitDeferred.reject(wrapped);
      return;
    }

    if (message.type === 'runtime') {
      if (!isDurableCliRuntime(message.runtimeRecord)) {
        const wrapped = buildError('Durable wrapper emitted an invalid runtime record');
        runtimeDeferred.reject(wrapped);
        exitDeferred.reject(wrapped);
        return;
      }
      runtimeRecord = message.runtimeRecord;
      runtimeDeferred.resolve(message.runtimeRecord);
      return;
    }

    if (!isExitRecord(message.exitRecord)) {
      const wrapped = buildError('Durable wrapper emitted an invalid exit record');
      runtimeDeferred.reject(wrapped);
      exitDeferred.reject(wrapped);
      return;
    }

    exitDeferred.resolve(message.exitRecord);
  };

  stdout.on('data', (chunk: string | Buffer) => {
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      handleControlLine(line);
    }
  });

  stderr.on('data', (chunk: string | Buffer) => {
    stderrBuffer += chunk.toString();
  });

  options.wrapper.on('error', (error: Error) => {
    const wrapped = buildError(`Durable wrapper failed: ${error.message}`);
    runtimeDeferred.reject(wrapped);
    exitDeferred.reject(wrapped);
  });

  options.wrapper.on('close', (code, signal) => {
    if (runtimeRecord === null) {
      runtimeDeferred.reject(
        buildError(
          signal
            ? `Durable wrapper exited before reporting runtime (signal ${signal})`
            : `Durable wrapper exited before reporting runtime (exit ${code})`,
        ),
      );
      return;
    }

    exitDeferred.reject(
      buildError(
        signal
          ? `Durable wrapper exited before reporting completion (signal ${signal})`
          : `Durable wrapper exited before reporting completion (exit ${code})`,
      ),
    );
  });

  const timeout = options.time.setTimeout(() => {
    const wrapped = buildError(`Durable wrapper failed to report runtime within ${DURABLE_POLL_TIMEOUT_MS}ms`);
    runtimeDeferred.reject(wrapped);
    exitDeferred.reject(wrapped);
  }, DURABLE_POLL_TIMEOUT_MS);
  timeout.unref?.();

  return runtimeDeferred.promise
    .finally(() => options.time.clearTimeout(timeout))
    .then((record) => ({
      runtimeRecord: record,
      exitPromise: exitDeferred.promise,
    }));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error) {
      if ((error as { code: string }).code === 'EPERM') return true;
      if ((error as { code: string }).code === 'ESRCH') return false;
    }
    return false;
  }
}

function normalizeSpawnSyncOutput(output: string | Buffer | null | undefined, encoding: BufferEncoding): string {
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
  data: StorageData,
  platform: NodeJS.Platform,
  options?: { encoding?: BufferEncoding; mode?: number },
): boolean {
  mkdirSync(dirname(path), { recursive: true });
  const mode = options?.mode ?? 0o600;
  try {
    writeFileSync(
      path,
      normalizeStorageData(data),
      options?.encoding === undefined ? { mode, flag: 'wx' } : { encoding: options.encoding, mode, flag: 'wx' },
    );
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
  data: StorageData,
  options?: { encoding?: BufferEncoding; mode?: number },
): boolean {
  const mode = options?.mode;
  const tempPath = `${path}.tmp`;
  try {
    writeFileSync(
      tempPath,
      normalizeStorageData(data),
      mode === undefined
        ? options?.encoding === undefined
          ? undefined
          : { encoding: options.encoding }
        : options?.encoding === undefined
          ? { mode }
          : { encoding: options.encoding, mode },
    );
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
  data: StorageData,
  options?: { encoding?: BufferEncoding; mode?: number },
): boolean {
  const mode = options?.mode;
  const parent = dirname(path);
  const tempPath = `${path}.tmp`;
  mkdirSync(parent, { recursive: true });

  let fd: number | null = null;
  try {
    fd = mode === undefined ? openSync(tempPath, 'w') : openSync(tempPath, 'w', mode);
    writeAllSync(fd, normalizeStorageBuffer(data, options?.encoding ?? 'utf-8'));
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

function normalizeStorageData(data: StorageData): string | Uint8Array {
  return typeof data === 'string' ? data : Buffer.from(data);
}

function normalizeStorageBuffer(data: StorageData, encoding: BufferEncoding): Buffer {
  return typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
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
