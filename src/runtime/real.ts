import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHash, randomBytes as randomBytesNode, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { homedir as osHomedir, tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { composeCoralPaths } from '../infra/path/index.js';
import { resolveProjectSource } from '../infra/project-source.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { ChildProcessLike, EnvPort, StorageData, StoragePort, TimePort } from '../infra/port-types.js';
import type {
  DurableExecutionTransport,
  IdPort,
  ProcessPort,
  Runtime,
  RuntimeExecOptions,
  RuntimePaths,
} from './ports.js';
import { errorMessage } from '../infra/error-format.js';
import { MAX_BUFFER } from '../infra/process-constants.js';
import { composeChildEnv, parsePassthrough, resolveEnvBudgetBytes } from '../infra/env-sanitize.js';
import { isDurableCliRuntime, type DurableCliRuntimeRecord, type DurableProcessExit } from './durable-runtime.js';
import { buildExecPromise } from './exec-builder.js';
import { createRealTimePort } from '../infra/time.js';

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

function shouldUseWindowsCommandShell(value) {
  if (process.platform !== 'win32') return false;
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat');
}

const child = spawn(command, args, {
  stdio: ['pipe', stdoutFd, stderrFd],
  cwd,
  env,
  shell: shouldUseWindowsCommandShell(command),
});

const runtimeRecord = {
  transport: 'durable-cli',
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
  arch: NodeJS.Architecture;
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

export interface CreateRealRuntimeOptions {
  /** Override the coral root's parent home. Tests pass a tmp dir to isolate
   *  all composed paths (including the per-project `projects/` tree) without
   *  mocking `node:os.homedir()`. Omitted in production. */
  readonly baseDir?: string;
}

export function createRealRuntime(flavor: BuildFlavor, opts?: CreateRealRuntimeOptions): Runtime {
  const capturedEnv = captureEnvState();
  const envBudgetBytes = resolveEnvBudgetBytes();
  const envPassthrough = parsePassthrough(capturedEnv.coralEnv.CORAL_ENV_PASSTHROUGH);
  const time: TimePort = createRealTimePort();

  const storage: StoragePort = {
    readFile: (path, encoding) => readFileAsync(path, encoding),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    mkdirSync: (path, options) => mkdirSync(path, options),
    rmSync: (path, options) => rmSync(path, options),
    readdirSync: ((path: string, options?: { withFileTypes: true }) => {
      if (options?.withFileTypes === true) {
        return readdirSync(path, options);
      }
      return readdirSync(path);
    }) as StoragePort['readdirSync'],
    readDirectoryBoundedSync: (path, limit) => {
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new TypeError('Directory entry limit must be a non-negative safe integer.');
      }
      const directory = opendirSync(path);
      const entries: string[] = [];
      let overflow = false;
      try {
        while (true) {
          const entry = directory.readSync();
          if (entry === null) break;
          if (entries.length === limit) {
            overflow = true;
            break;
          }
          entries.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      return { entries, overflow };
    },
    lstatSync: (path) => {
      const stats = lstatSync(path);
      return {
        isDirectory: () => stats.isDirectory(),
        isFile: () => stats.isFile(),
        isSymbolicLink: () => stats.isSymbolicLink(),
      };
    },
    realpathSync: (path) => realpathSync(path),
    statSync: ((path: string, options?: { bigint: true }) => {
      if (options?.bigint === true) {
        const stats = statSync(path, { bigint: true });
        return {
          dev: stats.dev,
          ino: stats.ino,
          mode: stats.mode,
          uid: stats.uid,
          size: stats.size,
          mtimeNs: stats.mtimeNs,
          isDirectory: () => stats.isDirectory(),
          isFile: () => stats.isFile(),
        };
      }
      const stats = statSync(path);
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isDirectory: () => stats.isDirectory(),
        isFile: () => stats.isFile(),
      };
    }) as StoragePort['statSync'],
    fstatSync: (fd, options) => {
      const stats = fstatSync(fd, options);
      return {
        dev: stats.dev,
        ino: stats.ino,
        mode: stats.mode,
        uid: stats.uid,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        isDirectory: () => stats.isDirectory(),
        isFile: () => stats.isFile(),
      };
    },
    existsSync: (path) => existsSync(path),
    openSync: (path, flags, mode) => (mode === undefined ? openSync(path, flags) : openSync(path, flags, mode)),
    readSync: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    writeSync: (fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, length, position),
    fdatasyncSync: (fd) => fdatasyncSync(fd),
    closeSync: (fd) => closeSync(fd),
    appendFileSync: (path, data) => appendFileSync(path, data),
    appendFileDurableSync: (path, data) => appendFileDurableSyncNode(path, data),
    appendFileWithCanonicalCheckSync: (path, data, options) =>
      appendFileWithCanonicalCheckSyncNode(path, data, options),
    rmdirSync: (path) => rmdirSync(path),
    unlinkSync: (path) => unlinkSync(path),
    tryExclusiveWriteSync: (path, data, options) =>
      tryExclusiveWriteSyncNode(path, data, capturedEnv.platform, options),
    writeAtomicSync: (path, data, options) => writeAtomicSyncNode(path, data, options),
    writeAtomicDurableSync: (path, data, options) => writeAtomicDurableSyncNode(path, data, options),
    syncDirectoryDurableSync: (path) => syncDirectoryDurable(path),
    chmodSync: (path, mode) => chmodSync(path, mode),
  };

  const customKbRoot = capturedEnv.coralEnv.CORAL_KB_PATH;
  const coral = composeCoralPaths(flavor, {
    ...(opts?.baseDir === undefined ? {} : { baseDir: opts.baseDir }),
    ...(customKbRoot ? { customKbRoot } : {}),
  });
  const paths: RuntimePaths = {
    projectSource: resolveProjectSource,
    projectData: (projectRoot) => coral.projects.dataDir(resolveProjectSource(projectRoot)),
    coral,
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
    return options.env ?? buildSpawnEnv();
  };

  const durableExitPromises = new Map<number, Promise<DurableProcessExit>>();
  const durable: DurableExecutionTransport = {
    launch: async (options) => {
      const envPath = `${options.jobDir}/${ENV_RECORD_FILE}`;
      writeAtomicJson(storage, envPath, options.env ?? buildSpawnEnv(options.envAdditions));

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
      const spawnEnv = options.env
        ? { ...options.env }
        : options.inheritEnv
          ? resolveExecEnv({ env: options.envAdditions, inheritEnv: true })
          : buildSpawnEnv(options.envAdditions);
      const child = spawnChild(options.command, options.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: options.cwd,
        shell: options.shell,
        detached: options.detached,
        env: spawnEnv,
      });
      return child as unknown as ChildProcessLike;
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        /* already dead */
        return false;
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
      shell: execOptions.shell,
      timeoutMs: execOptions.timeout,
      maxBuffer: execOptions.maxBuffer,
      encoding: execOptions.encoding ?? 'utf-8',
      killProcessGroup: capturedEnv.platform !== 'win32',
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
      shell: execOptions.shell ?? false,
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
    tmpdir: () => osTmpdir(),
    pid: () => capturedEnv.pid,
    platform: () => capturedEnv.platform,
    arch: () => capturedEnv.arch,
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
    arch: process.arch,
    cwd: process.cwd(),
  };
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
      const wrapped = buildError(`Durable wrapper emitted invalid control JSON (${errorMessage(error)})`);
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
  const writeOptions: { encoding?: BufferEncoding; mode: number; flag: 'wx' } = { mode, flag: 'wx' };
  if (options?.encoding !== undefined) {
    writeOptions.encoding = options.encoding;
  }
  try {
    writeFileSync(path, normalizeStorageData(data), writeOptions);
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
  const tempPath = `${path}.tmp`;
  try {
    writeFileSync(tempPath, normalizeStorageData(data), writeFileSyncOptions(options));
    renameSync(tempPath, path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function writeFileSyncOptions(options?: {
  encoding?: BufferEncoding;
  mode?: number;
}): { encoding?: BufferEncoding; mode?: number } | undefined {
  if (options === undefined || (options.encoding === undefined && options.mode === undefined)) {
    return undefined;
  }

  const { encoding, mode } = options;
  return {
    ...(encoding === undefined ? {} : { encoding }),
    ...(mode === undefined ? {} : { mode }),
  };
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
    if (mode !== undefined) {
      fchmodSync(fd, mode);
    }
    writeAllSync(fd, normalizeStorageBuffer(data, options?.encoding ?? 'utf-8'));
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
    return syncDirectoryDurable(parent);
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

function appendFileWithCanonicalCheckSyncNode(
  path: string,
  data: string,
  options: { canonicalPath: string; maxRetries?: number },
): { ok: boolean; retries: number; orphanPath?: string } {
  const buffer = Buffer.from(data, 'utf-8');
  const maxRetries = normalizeMaxRetries(options.maxRetries);
  let retries = 0;
  let targetPath = path;
  let lastOrphanPath: string | undefined;

  while (true) {
    try {
      const result = appendAndCheckCanonicalSync(targetPath, buffer, options.canonicalPath);
      if (result.ok) {
        return { ok: true, retries };
      }
      lastOrphanPath = result.orphanPath;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, retries, ...(lastOrphanPath ? { orphanPath: lastOrphanPath } : {}) };
      }
      throw error;
    }

    if (retries >= maxRetries) {
      return { ok: false, retries, ...(lastOrphanPath ? { orphanPath: lastOrphanPath } : {}) };
    }

    retries += 1;
    targetPath = options.canonicalPath;
  }
}

function appendAndCheckCanonicalSync(
  path: string,
  buffer: Buffer,
  canonicalPath: string,
): { ok: true } | { ok: false; orphanPath: string } {
  mkdirSync(dirname(path), { recursive: true });

  let fd: number | null = null;
  try {
    fd = openSync(path, 'a');
    writeAllSync(fd, buffer);
    fdatasyncSync(fd);

    const openedIdentity = fileIdentityFromStats(fstatSync(fd));
    const canonicalIdentity = statFileIdentity(canonicalPath);
    if (canonicalIdentity && sameFileIdentity(openedIdentity, canonicalIdentity)) {
      return { ok: true };
    }

    return {
      ok: false,
      orphanPath: findPathByIdentity(dirname(canonicalPath), openedIdentity) ?? path,
    };
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function normalizeMaxRetries(maxRetries: number | undefined): number {
  if (maxRetries === undefined) {
    return 3;
  }
  if (!Number.isFinite(maxRetries)) {
    return 0;
  }
  return Math.max(0, Math.floor(maxRetries));
}

function fileIdentityFromStats(stats: { dev: number; ino: number }): { dev: number; ino: number } {
  return { dev: stats.dev, ino: stats.ino };
}

function statFileIdentity(path: string): { dev: number; ino: number } | null {
  try {
    return fileIdentityFromStats(statSync(path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function sameFileIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function findPathByIdentity(parent: string, identity: { dev: number; ino: number }): string | undefined {
  try {
    for (const entry of readdirSync(parent)) {
      const candidate = join(parent, entry);
      const candidateIdentity = statFileIdentity(candidate);
      if (candidateIdentity && sameFileIdentity(candidateIdentity, identity)) {
        return candidate;
      }
    }
  } catch {
    /* best effort */
  }
  return undefined;
}

function writeAllSync(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

// A caller that requests durable publication must observe an unsupported or
// failed directory fsync and fail closed before it mutates dependent state.
function syncDirectoryDurable(path: string): boolean {
  let dirFd: number | null = null;
  try {
    dirFd = openSync(path, 'r');
    fsyncSync(dirFd);
    return true;
  } catch {
    return false;
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
