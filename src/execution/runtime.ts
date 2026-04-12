import { spawn as spawnChild } from 'node:child_process';
import { randomBytes as randomBytesNode, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  chmodSync,
  existsSync,
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
} from 'node:fs';
import { dirname } from 'node:path';
import {
  parsePassthrough,
  resolveEnvBudgetBytes,
  shedIfOverBudget,
  stripInternalCoralKeys,
} from '../shared/env-sanitize.js';
import {
  backendInfoPath,
  backendLockPath,
  jobsDir,
  pluginRootNamespace,
  resolveProjectSource,
  sessionBase,
} from '../infra/paths.js';
import { isDurableCliRuntime, type DurableCliRuntimeRecord, type PersistedExitRecord } from '../shared/types.js';
import type { LaunchPool } from './engine.js';

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

export interface RuntimeTimerHandle {
  unref?(): void;
}

export interface RuntimeTime {
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimeout(fn: () => void, ms: number): RuntimeTimerHandle;
  clearTimeout(handle: RuntimeTimerHandle | null): void;
  setInterval(fn: () => void, ms: number): RuntimeTimerHandle;
  clearInterval(handle: RuntimeTimerHandle | null): void;
}

export interface RuntimeDirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface RuntimeStorage {
  readFileSync(path: string, encoding: 'utf-8'): string;
  writeFileSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): void;
  renameSync(oldPath: string, newPath: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  readdirSync(path: string, options: { withFileTypes: true }): RuntimeDirentLike[];
  statSync(path: string): { size: number; mtimeMs: number; isDirectory(): boolean; isFile(): boolean };
  existsSync(path: string): boolean;
  openSync(path: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
  appendFileSync(path: string, data: string): void;
  unlinkSync(path: string): void;
  tryExclusiveWriteSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  writeAtomicSync(path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }): boolean;
  chmodSync(path: string, mode: number): void;
  jobsDir(): string;
  sessionBase(): string;
  backendInfoPath(pluginRoot: string): string;
  backendLockPath(pluginRoot: string): string;
  pluginRootNamespace(pluginRoot: string): string;
  projectSource(projectRoot: string): string;
}

export interface ChildStdinLike {
  readonly destroyed: boolean;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface ChildReadableLike {
  setEncoding(encoding: BufferEncoding): this;
  on(event: 'data', listener: (chunk: string | Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  [Symbol.asyncIterator]?(): AsyncIterableIterator<string | Buffer>;
}

export interface ChildProcessLike {
  readonly pid: number | undefined;
  readonly stdin: ChildStdinLike | null;
  readonly stdout: ChildReadableLike | null;
  readonly stderr: ChildReadableLike | null;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}

export type RuntimeSpawnMode = 'piped' | 'ignored' | 'detached';

export type RuntimeSpawnOptions = {
  command: string;
  args: string[];
  cwd?: string;
  envAdditions?: Record<string, string>;
  shell?: boolean;
  mode: RuntimeSpawnMode;
};

export type DurableLaunchOptions = {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  jobDir: string;
  pool?: LaunchPool;
  envAdditions?: Record<string, string>;
};

export type DurableLaunchResult = {
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  runtimeRecord: DurableCliRuntimeRecord;
};

export interface DurableExecutionTransport {
  launch(options: DurableLaunchOptions): Promise<DurableLaunchResult>;
  waitForExit(handle: DurableLaunchResult): Promise<PersistedExitRecord>;
}

export interface RuntimeProcess {
  spawn(options: RuntimeSpawnOptions): ChildProcessLike;
  kill(pid: number, signal: NodeJS.Signals | 0): void;
  isAlive(pid: number): boolean;
  durable: DurableExecutionTransport;
}

export interface RuntimeIds {
  uuid(): string;
  randomBytes(size: number): Buffer;
}

export interface RuntimeEnv {
  get(key: string): string | undefined;
  pid(): number;
  platform(): string;
  cwd(): string;
  coralSnapshot(): Readonly<Record<string, string>>;
}

export interface Runtime {
  time: RuntimeTime;
  storage: RuntimeStorage;
  process: RuntimeProcess;
  ids: RuntimeIds;
  env: RuntimeEnv;
}

export type RuntimeTimePort = Runtime['time'];
export type RuntimeStoragePort = Runtime['storage'];
export type RuntimeProcessPort = Runtime['process'];
export type RuntimeIdsPort = Runtime['ids'];
export type RuntimeEnvPort = Runtime['env'];

type CapturedEnvState = {
  fullEnv: Readonly<Record<string, string>>;
  inheritedEnv: Readonly<Record<string, string>>;
  coralEnv: Readonly<Record<string, string>>;
  pid: number;
  platform: NodeJS.Platform;
  cwd: string;
};

export function createRealRuntime(): Runtime {
  const capturedEnv = captureEnvState();
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
    unlinkSync: (path) => unlinkSync(path),
    tryExclusiveWriteSync: (path, data, options) => tryExclusiveWriteSyncNode(path, data, capturedEnv.platform, options),
    writeAtomicSync: (path, data, options) => writeAtomicSyncNode(path, data, options),
    chmodSync: (path, mode) => chmodSync(path, mode),
    jobsDir,
    sessionBase,
    backendInfoPath,
    backendLockPath,
    pluginRootNamespace,
    projectSource: resolveProjectSource,
  };

  const buildSpawnEnv = (envAdditions?: Record<string, string>): Record<string, string> => {
    return {
      ...capturedEnv.inheritedEnv,
      ...envAdditions,
      CORAL_CHILD: '1',
    };
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
      const child = spawnChild(options.command, options.args, {
        stdio: toNodeStdio(options.mode),
        cwd: options.cwd,
        shell: options.shell,
        env: buildSpawnEnv(options.envAdditions),
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

  const stripped = stripInternalCoralKeys(fullEnv);
  const budget = resolveEnvBudgetBytes();
  const passthrough = parsePassthrough(coralEnv.CORAL_ENV_PASSTHROUGH);

  return {
    fullEnv: Object.freeze({ ...fullEnv }),
    inheritedEnv: Object.freeze(shedIfOverBudget(stripped, budget, passthrough)),
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
