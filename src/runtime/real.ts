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
  getSettledBuildFlavor,
  installationDirForNamespace,
  jobStatusPath,
  jobsDir,
  pluginRootNamespace,
  resolveProjectSource,
  sessionBase,
} from '../infra/paths.js';
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
  StoragePort,
  TimePort,
} from './ports.js';
import { CoralSetupError } from './errors.js';
import { MAX_BUFFER } from '../shared/process-constants.js';
import { composeChildEnv, parsePassthrough, resolveEnvBudgetBytes } from '../shared/env-sanitize.js';
import { isDurableCliRuntime } from './durable-runtime.js';
import type { DurableCliRuntimeRecord, JobExitRecord } from './durable-runtime.js';
import { buildExecPromise } from './exec-builder.js';

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
  const time: TimePort = {
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
    tryExclusiveWriteSync: (path, data, options) => tryExclusiveWriteSyncNode(path, data, capturedEnv.platform, options),
    writeAtomicSync: (path, data, options) => writeAtomicSyncNode(path, data, options),
    writeAtomicDurableSync: (path, data, options) => writeAtomicDurableSyncNode(path, data, options),
    chmodSync: (path, mode) => chmodSync(path, mode),
  };

  let cachedCoralPaths: CoralPaths | undefined;
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
    get coral(): CoralPaths {
      if (cachedCoralPaths !== undefined) {
        return cachedCoralPaths;
      }
      const settled = getSettledBuildFlavor();
      if (settled === null) {
        throw new CoralSetupError({
          code: 'E_FLAVOR_NOT_SETTLED',
          userMessage: 'Runtime.paths.coral accessed before setBuildFlavor settled',
          remediation:
            'Ensure setBuildFlavor() is called during composition-root bootstrap before any paths.coral consumer runs. See src/execution/composition/backend-world.ts.',
        });
      }
      cachedCoralPaths = Object.freeze(composeCoralPaths(settled));
      return cachedCoralPaths;
    },
  };

  const buildSpawnEnv = (envAdditions?: Record<string, string>): Record<string, string> => {
    return composeChildEnv({ ...capturedEnv.fullEnv }, envAdditions ?? {}, envBudgetBytes, envPassthrough);
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
      let exitedAt = null as number | null;

      while (true) {
        const record = readJsonIfPresent<JobExitRecord>(storage, exitPath);
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

async function waitForRuntimeRecord(options: {
  storage: StoragePort;
  time: TimePort;
  process: Pick<ProcessPort, 'isAlive'>;
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

function readJsonIfPresent<T>(storage: StoragePort, path: string): T | null {
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
