import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createHash, randomBytes as randomBytesNode, randomUUID } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
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
  constants as fsConstants,
} from 'node:fs';
import {
  lstat as lstatAsync,
  open as openAsync,
  readFile as readFileAsync,
  readdir as readdirAsync,
  rm as rmAsync,
  unlink as unlinkAsync,
} from 'node:fs/promises';
import { homedir as osHomedir, tmpdir as osTmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { composeCoralPaths } from '../infra/path/index.js';
import { resolveProjectSource } from '../infra/project-source.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type {
  ChildProcessLike,
  EnvPort,
  ProcessIdentityObservation,
  SqliteDatabasePort,
  StorageData,
  StoragePort,
  TimePort,
} from '../infra/port-types.js';
import type {
  DurableExecutionTransport,
  DurableCliProcessSubject,
  DurableLaunchHeld,
  DurableLaunchHandle,
  DurableLaunchRetryDisposition,
  DurableLaunchSignalAuthority,
  IdPort,
  ProcessPort,
  Runtime,
  RuntimeExecOptions,
  RuntimePaths,
} from './ports.js';
import { assertNever, errorMessage } from '../infra/error-format.js';
import {
  DEFAULT_SYNC_EXEC_TIMEOUT_MS,
  EXEC_MAXBUFFER_CODE,
  EXEC_TIMEOUT_CODE,
  SPAWN_SYNC_MAXBUFFER_ERRNO,
  MAX_BUFFER,
} from '../infra/process-constants.js';
import { composeChildEnv, parsePassthrough, resolveEnvBudgetBytes } from '../infra/env-sanitize.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from './durable-runtime.js';
import { buildExecPromise } from './exec-builder.js';
import { createRealTimePort } from '../infra/time.js';
import {
  createAsyncRecordedProcessObserver,
  observeProcessLiveness,
  parseLinuxProcessIncarnation,
  probeProcessIncarnation,
  probeProcessIncarnationAsync,
  isProcessIncarnation,
  type ProcessIncarnation,
  type ProcessIncarnationProbeTerminator,
} from '../infra/node-process.js';
import { observeRecordedContainment, type RecordedProcessIdentity } from '../infra/process-containment.js';
import {
  gracefulKill,
  liveChildAuthority,
  type GracefulKillDisposition,
  type GracefulKillPendingDisposition,
} from '../infra/process-supervision.js';

declare const __BUNDLE_DIR__: string | undefined;

const DURABLE_POLL_INTERVAL_MS = 100;
const DURABLE_POLL_TIMEOUT_MS = 5_000;
const DURABLE_EXIT_GRACE_MS = 5_000;
const ENV_RECORD_FILE = 'env.json';
const LAUNCH_PAYLOAD_FILE = 'launch.v1.json';
const DURABLE_WRAPPER_BUNDLE_FILE = 'coral-durable-wrapper.cjs';

type ProcessIdentityObservationEnvironment = Readonly<{
  platform: string;
  observeLiveness(pid: number): ReturnType<typeof observeProcessLiveness>;
  readFile(path: string, options: { encoding: 'utf-8'; signal: AbortSignal }): Promise<string>;
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
}>;

function unobservable(
  owner: RecordedProcessIdentity,
  cause: Extract<ProcessIdentityObservation['evidence'], { kind: 'unobservable' }>['cause'],
): ProcessIdentityObservation {
  return { owner, evidence: { kind: 'unobservable', cause } };
}

function abortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError');
}

export async function observeProcessIdentitiesWithoutSubprocesses(
  owners: readonly RecordedProcessIdentity[],
  deadlineMs: number,
  environment: ProcessIdentityObservationEnvironment,
): Promise<readonly ProcessIdentityObservation[]> {
  if (owners.length === 0) return [];
  const controller = new AbortController();
  const deadline = environment.time.setTimeout(() => controller.abort(), deadlineMs);
  try {
    const pendingOwners = owners.map((owner) => ({ owner, liveness: environment.observeLiveness(owner.pid) }));
    if (environment.platform !== 'linux') {
      return pendingOwners.map(({ owner, liveness }) => {
        switch (liveness) {
          case 'absent':
            return { owner, evidence: { kind: 'pid-absent' } };
          case 'alive':
            return unobservable(owner, 'probe-not-available');
          case 'unknown':
            return unobservable(owner, 'probe-failed');
          default:
            return assertNever(liveness);
        }
      });
    }

    let bootId: string;
    try {
      bootId = await environment.readFile('/proc/sys/kernel/random/boot_id', {
        encoding: 'utf-8',
        signal: controller.signal,
      });
    } catch (error: unknown) {
      const cause = abortError(error, controller.signal) ? 'deadline-expired' : 'probe-failed';
      return pendingOwners.map(({ owner, liveness }) =>
        liveness === 'absent' ? { owner, evidence: { kind: 'pid-absent' } } : unobservable(owner, cause),
      );
    }

    if (bootId.trim().length === 0) {
      return pendingOwners.map(({ owner, liveness }) =>
        liveness === 'absent'
          ? { owner, evidence: { kind: 'pid-absent' } }
          : unobservable(owner, 'incarnation-unavailable'),
      );
    }

    return Promise.all(
      pendingOwners.map(async ({ owner, liveness }): Promise<ProcessIdentityObservation> => {
        if (liveness === 'absent') return { owner, evidence: { kind: 'pid-absent' } };
        try {
          const stat = await environment.readFile(`/proc/${owner.pid}/stat`, {
            encoding: 'utf-8',
            signal: controller.signal,
          });
          const incarnation = parseLinuxProcessIncarnation(bootId, stat);
          return incarnation === null
            ? unobservable(owner, 'incarnation-unavailable')
            : { owner, evidence: { kind: 'incarnation', incarnation } };
        } catch (error: unknown) {
          if (abortError(error, controller.signal)) return unobservable(owner, 'deadline-expired');
          if (
            (error as NodeJS.ErrnoException).code === 'ENOENT' &&
            environment.observeLiveness(owner.pid) === 'absent'
          ) {
            return { owner, evidence: { kind: 'pid-absent' } };
          }
          return unobservable(
            owner,
            (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'incarnation-unavailable' : 'probe-failed',
          );
        }
      }),
    );
  } finally {
    environment.time.clearTimeout(deadline);
  }
}

function openSqliteDatabaseSync(path: string, options?: { readOnly?: boolean }): SqliteDatabasePort {
  const database = new DatabaseSync(path, { readOnly: options?.readOnly ?? false });
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        all: (...values) => statement.all(...values),
        get: (...values) => statement.get(...values),
        run: (...values) => {
          const result = statement.run(...values);
          return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        },
      };
    },
    close: () => database.close(),
  };
}

function durableWrapperEntrypoint(): string {
  if (typeof __BUNDLE_DIR__ === 'string') {
    return join(__BUNDLE_DIR__, DURABLE_WRAPPER_BUNDLE_FILE);
  }
  return fileURLToPath(new URL('../../dist/runtime/durable-cli-wrapper.js', import.meta.url));
}

export async function waitForRecordedDurableExit(
  processSubject: DurableCliProcessSubject,
  pid: number,
  platform: NodeJS.Platform,
  time: Pick<TimePort, 'monotonicNow' | 'sleep'>,
): Promise<never> {
  let exitedAt = null as bigint | null;
  while (true) {
    const observation = observeRecordedContainment(processSubject, {
      process: { observeLiveness: observeProcessLiveness },
      platform,
      readProcessIncarnation: probeProcessIncarnation,
    });
    if (observation.kind === 'absent') {
      exitedAt ??= time.monotonicNow();
      if (time.monotonicNow() - exitedAt >= BigInt(DURABLE_EXIT_GRACE_MS)) {
        throw new Error(`Durable process ${pid} exited before the wrapper reported completion`);
      }
    } else {
      exitedAt = null;
    }
    await time.sleep(DURABLE_POLL_INTERVAL_MS);
  }
}

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
      leaderIncarnation: ProcessIncarnation | null;
      childRoot: RecordedProcessIdentity | null;
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
    assertReadableSync: (path) => accessSync(path, fsConstants.R_OK),
    observeDirectoryTraversabilitySync: (path) => {
      // Node documents `fs.constants.X_OK` as having no effect on Windows, so it cannot establish
      // traversability there.
      if (capturedEnv.platform === 'win32') return 'unobserved';
      try {
        accessSync(path, fsConstants.X_OK);
        return 'traversable';
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        return code === 'EACCES' || code === 'EPERM' || code === 'ENOENT' ? 'denied' : 'unobserved';
      }
    },
    readFile: (path, encoding) => readFileAsync(path, encoding),
    readdir: (path) => readdirAsync(path),
    readFileSync: (path, encoding) => readFileSync(path, encoding),
    writeFileSync: (path, data, options) => writeFileSync(path, data, options),
    renameSync: (oldPath, newPath) => renameSync(oldPath, newPath),
    linkSync: (existingPath, newPath) => linkSync(existingPath, newPath),
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
    lstatSync: ((path: string, options?: { bigint: true }) => {
      if (options?.bigint === true) {
        const stats = lstatSync(path, { bigint: true });
        return {
          dev: stats.dev,
          ino: stats.ino,
          nlink: stats.nlink,
          mode: stats.mode,
          uid: stats.uid,
          size: stats.size,
          mtimeNs: stats.mtimeNs,
          isDirectory: () => stats.isDirectory(),
          isFile: () => stats.isFile(),
        };
      }
      const stats = lstatSync(path);
      return {
        isDirectory: () => stats.isDirectory(),
        isFile: () => stats.isFile(),
        isSymbolicLink: () => stats.isSymbolicLink(),
      };
    }) as StoragePort['lstatSync'],
    lstat: async (path) => {
      const stats = await lstatAsync(path);
      return {
        size: stats.size,
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
          nlink: stats.nlink,
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
        nlink: stats.nlink,
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
    rm: (path, options) => rmAsync(path, options),
    unlink: (path) => unlinkAsync(path),
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
    syncDirectoryDurable: (path) => syncDirectoryDurableAsync(path),
    chmodSync: (path, mode) => chmodSync(path, mode),
    openSqliteDatabaseSync,
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

  const durableExitRegistrations = new Map<
    DurableLaunchHandle,
    Readonly<{
      pid: number;
      processSubject: DurableCliProcessSubject;
      exitPromise: Promise<DurableProcessExit>;
    }>
  >();
  const durable: DurableExecutionTransport = {
    launch: async (options) => {
      if (capturedEnv.platform === 'win32') {
        throw new Error(
          'Durable CLI launch is unsupported on Windows because Coral cannot observe or terminate a POSIX process group there.',
        );
      }
      const envPath = `${options.jobDir}/${ENV_RECORD_FILE}`;
      const launchPayloadPath = `${options.jobDir}/${LAUNCH_PAYLOAD_FILE}`;
      const startTime = new Date(time.now()).toISOString();
      storage.writeAtomicSync(envPath, JSON.stringify(options.env ?? buildSpawnEnv(options.envAdditions)), {
        mode: 0o600,
      });
      storage.writeAtomicSync(
        launchPayloadPath,
        JSON.stringify({
          version: 1,
          command: options.command,
          args: options.args,
          cwd: options.cwd ?? null,
          prompt: options.prompt ?? '',
          startTime,
        }),
        { mode: 0o600 },
      );

      const wrapper = spawnChild(process.execPath, [durableWrapperEntrypoint(), launchPayloadPath], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: buildSpawnEnv(),
      });
      let wrapperUnreferenced = false;
      const unrefWrapper = (): void => {
        if (wrapperUnreferenced) return;
        wrapperUnreferenced = true;
        wrapper.unref();
        wrapper.channel?.unref();
      };

      let wrapperClosed = false;
      const wrapperSettlement = new Promise<void>((resolve) => {
        wrapper.on('close', () => {
          wrapperClosed = true;
          resolve();
        });
      });
      let wrapperTermination: GracefulKillPendingDisposition | null = null;
      const requestWrapperTermination = (): GracefulKillDisposition => {
        if (wrapperTermination !== null) return wrapperTermination;
        const disposition = gracefulKill(wrapper as unknown as ChildProcessLike, { time }, observeProcessLiveness);
        if ('settlement' in disposition) {
          wrapperTermination = disposition;
          void disposition.settlement.then(() => {
            if (wrapperTermination === disposition) wrapperTermination = null;
          });
        }
        return disposition;
      };

      const holdLaunchFailure = (
        reason: string,
        retryAfter = time.sleep(DURABLE_POLL_INTERVAL_MS),
      ): DurableLaunchHeld => {
        const retry = async (): Promise<DurableLaunchRetryDisposition> => {
          const termination = requestWrapperTermination();
          if (wrapperClosed) return { disposition: 'settled' };
          if (wrapper.pid !== undefined) {
            try {
              if (observeProcessLiveness(wrapper.pid) === 'absent') return { disposition: 'settled' };
            } catch {
              // Unknown liveness retains the close-backed launch obligation.
            }
          }
          return holdLaunchFailure(
            reason,
            'settlement' in termination
              ? termination.settlement.then(() => undefined)
              : time.sleep(DURABLE_POLL_INTERVAL_MS),
          );
        };
        return {
          disposition: 'held',
          owner: 'launch-caller',
          pid: wrapper.pid ?? null,
          reason,
          retryAfter: Promise.race([wrapperSettlement, retryAfter]),
          retry,
        };
      };

      let ownershipAccepted = false;
      const resolveLaunchFailure = async (reason: string): Promise<DurableLaunchHeld> => {
        let disposition = holdLaunchFailure(reason);
        if (ownershipAccepted) return disposition;
        while (true) {
          await disposition.retryAfter;
          const retry = await disposition.retry();
          if (retry.disposition === 'settled') throw new Error(reason);
          disposition = retry;
        }
      };

      try {
        const ownershipAcceptance = options.onWrapperSpawned?.({
          pid: wrapper.pid ?? null,
          settled: wrapperSettlement,
          requestTermination: requestWrapperTermination,
        });
        if (options.onWrapperSpawned !== undefined && ownershipAcceptance?.kind !== 'accepted') {
          return resolveLaunchFailure('Durable wrapper ownership was not accepted.');
        }
        if (ownershipAcceptance?.kind === 'accepted') {
          ownershipAccepted = true;
          unrefWrapper();
        }
      } catch (error: unknown) {
        return resolveLaunchFailure(`Durable wrapper ownership was refused: ${errorMessage(error)}`);
      }

      const wrapperAuthority = liveChildAuthority(wrapper as unknown as ChildProcessLike);
      const signalAuthority: DurableLaunchSignalAuthority | undefined =
        wrapperAuthority === undefined
          ? undefined
          : Object.freeze({
              ...wrapperAuthority,
              requestTermination: requestWrapperTermination,
            });

      let initiallyObservedLeaderIncarnation: ProcessIncarnation | null = null;
      if (wrapper.pid !== undefined) {
        try {
          initiallyObservedLeaderIncarnation = probeProcessIncarnation(wrapper.pid, capturedEnv.platform);
        } catch {
          initiallyObservedLeaderIncarnation = null;
        }
      }
      if (wrapper.pid === undefined || initiallyObservedLeaderIncarnation === null) {
        return resolveLaunchFailure(
          'Durable launch could not establish the wrapper process identity before provider spawn. Retry the job; if this persists, verify process inspection permissions.',
        );
      }
      const provisionalRuntimeRecord: DurableCliRuntimeRecord = {
        transport: 'durable-cli',
        pid: wrapper.pid,
        stdoutPath: `${options.jobDir}/stdout`,
        stderrPath: `${options.jobDir}/stderr`,
        startTime,
      };
      const readiness = waitForDurableRuntime({
        time,
        wrapper,
      });
      try {
        options.onWrapperIdentified?.({
          runtimeRecord: provisionalRuntimeRecord,
          pid: wrapper.pid,
          leaderIncarnation: initiallyObservedLeaderIncarnation,
          ...(signalAuthority === undefined ? {} : { signalAuthority }),
        });
        await new Promise<void>((resolve, reject) => {
          wrapper.send('runtime-start-published', (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      } catch (error: unknown) {
        void readiness.catch(() => {});
        return resolveLaunchFailure(errorMessage(error));
      }

      let ready;
      try {
        ready = await readiness;
      } catch (error: unknown) {
        return resolveLaunchFailure(errorMessage(error));
      }
      const { runtimeRecord, reportedLeaderIncarnation, childRoot, exitPromise } = ready;
      if (
        initiallyObservedLeaderIncarnation !== null &&
        reportedLeaderIncarnation !== null &&
        initiallyObservedLeaderIncarnation !== reportedLeaderIncarnation
      ) {
        void exitPromise.catch(() => {});
        return resolveLaunchFailure('Durable wrapper identity changed before launch readiness. Retry the job.');
      }
      const leaderIncarnation = initiallyObservedLeaderIncarnation ?? reportedLeaderIncarnation;
      if (leaderIncarnation === null || childRoot === null) {
        void exitPromise.catch(() => {});
        return resolveLaunchFailure(
          'Durable launch could not establish a recoverable process identity. Retry the job; if this persists, verify process inspection permissions.',
        );
      }
      const processSubject: DurableCliProcessSubject = {
        pid: runtimeRecord.pid,
        incarnation: leaderIncarnation,
        processGroupId: runtimeRecord.pid,
        childRoot,
      };
      try {
        options.onSpawned?.({
          runtimeRecord,
          leaderIncarnation,
          childRoot,
          ...(signalAuthority === undefined ? {} : { signalAuthority }),
        });
      } catch (error: unknown) {
        void exitPromise.catch(() => {});
        return resolveLaunchFailure(errorMessage(error));
      }
      const launchHandle = randomUUID() as DurableLaunchHandle;
      durableExitRegistrations.set(launchHandle, { pid: runtimeRecord.pid, processSubject, exitPromise });
      unrefWrapper();

      return {
        disposition: 'launched',
        launchHandle,
        pid: runtimeRecord.pid,
        stdoutPath: runtimeRecord.stdoutPath,
        stderrPath: runtimeRecord.stderrPath,
        runtimeRecord,
        processSubject,
        ...(signalAuthority === undefined ? {} : { signalAuthority }),
      };
    },
    waitForExit: async (handle) => {
      const registration = durableExitRegistrations.get(handle.launchHandle);
      if (
        registration === undefined ||
        registration.pid !== handle.pid ||
        registration.processSubject.pid !== handle.processSubject.pid ||
        registration.processSubject.incarnation !== handle.processSubject.incarnation ||
        registration.processSubject.processGroupId !== handle.processSubject.processGroupId ||
        registration.processSubject.childRoot.pid !== handle.processSubject.childRoot.pid ||
        registration.processSubject.childRoot.incarnation !== handle.processSubject.childRoot.incarnation
      ) {
        throw new Error(`Durable launch ${handle.launchHandle} is not attached to process ${handle.pid}.`);
      }

      try {
        return await registration.exitPromise;
      } catch (error: unknown) {
        await waitForRecordedDurableExit(registration.processSubject, registration.pid, capturedEnv.platform, time);
        throw error;
      } finally {
        if (durableExitRegistrations.get(handle.launchHandle) === registration) {
          durableExitRegistrations.delete(handle.launchHandle);
        }
      }
    },
  };

  const terminateProcessIncarnationProbe: ProcessIncarnationProbeTerminator = (child) => {
    gracefulKill(child as ChildProcessLike, { time }, observeProcessLiveness);
  };

  const observeRecordedProcessAsync = createAsyncRecordedProcessObserver({
    readIncarnation: (pid) => probeProcessIncarnationAsync(pid, terminateProcessIncarnationProbe, capturedEnv.platform),
    observeLiveness: observeProcessLiveness,
  });

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
        return false;
      }
    },
    observeLiveness: (pid) => observeProcessLiveness(pid),
    readProcessIncarnation: (pid, platform) => probeProcessIncarnation(pid, platform),
    observeRecordedProcessAsync,
    observeProcessIdentities: (owners, deadlineMs) =>
      observeProcessIdentitiesWithoutSubprocesses(owners, deadlineMs, {
        platform: capturedEnv.platform,
        observeLiveness: observeProcessLiveness,
        readFile: readFileAsync,
        time,
      }),
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
    // Bounded for the same reason `maxBuffer` is, and only on the synchronous variant. Abandoning `exec`'s
    // promise does not stop its child either — what differs is that the event loop keeps running while it
    // finishes, so an `AbortSignal` or a shutdown budget still gets its turn. This one blocks until the child
    // decides otherwise, and nothing in this process gets a turn at all. `RuntimeExecOptions.timeout` stays
    // optional so a caller may widen or tighten it, but omission must not mean unbounded — and `0`, which
    // `spawnSync` reads as no bound, is not a tightening, so it is corrected rather than honoured.
    if (execOptions.timeout === undefined || execOptions.timeout <= 0) {
      execOptions.timeout = DEFAULT_SYNC_EXEC_TIMEOUT_MS;
    }
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

    // The two branches below substitute a `code` for whatever `spawnSync` put on `result.error`, so what a
    // caller sees names which non-answer this was instead of an error with no code at all.
    if (result.error) {
      // Sorted on `spawnSync`'s own code, not on the shape around it. A `maxBuffer` overflow arrives as
      // `ENOBUFS` either way, but its shape depends on whether the child finished writing before Node killed
      // it — `signal: null` when it did, `signal: 'SIGTERM'` when it did not — and a timeout arrives in that
      // same second shape. So reading the shape puts a loaded machine's overflow on the timeout side, while
      // the code separates every case `spawnSync` produces here: `ENOBUFS`, `ETIMEDOUT`, and a launch errno.
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === SPAWN_SYNC_MAXBUFFER_ERRNO) {
        return {
          stdout,
          stderr,
          status: null,
          error: Object.assign(new Error(`maxBuffer exceeded: ${command}`), { code: EXEC_MAXBUFFER_CODE }),
        };
      }
      if (code === EXEC_TIMEOUT_CODE || result.signal) {
        return {
          stdout,
          stderr,
          status: null,
          error: Object.assign(new Error(`timeout: ${command}`), { code: EXEC_TIMEOUT_CODE }),
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
        error: Object.assign(new Error(`timeout: ${command}`), { code: EXEC_TIMEOUT_CODE }),
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

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isDurableRuntimeRecord(value: unknown): value is DurableCliRuntimeRecord {
  const keys =
    value !== null && typeof value === 'object' && Object.hasOwn(value, 'tailWatermark')
      ? ['transport', 'pid', 'stdoutPath', 'stderrPath', 'startTime', 'tailWatermark']
      : ['transport', 'pid', 'stdoutPath', 'stderrPath', 'startTime'];
  return (
    hasExactKeys(value, keys) &&
    value.transport === 'durable-cli' &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.stdoutPath === 'string' &&
    typeof value.stderrPath === 'string' &&
    typeof value.startTime === 'string' &&
    (!Object.hasOwn(value, 'tailWatermark') ||
      (typeof value.tailWatermark === 'number' &&
        Number.isSafeInteger(value.tailWatermark) &&
        value.tailWatermark >= 0))
  );
}

function isExitRecord(value: unknown): value is DurableProcessExit {
  return (
    hasExactKeys(value, ['exitCode', 'signal', 'endTime']) &&
    typeof value.endTime === 'string' &&
    (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))) &&
    (value.signal === null || typeof value.signal === 'string')
  );
}

function isRecordedProcessIdentity(value: unknown): value is RecordedProcessIdentity {
  return (
    hasExactKeys(value, ['pid', 'incarnation']) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    isProcessIncarnation(value.incarnation)
  );
}

function isDurableControlMessage(value: unknown, expectedPid: number | undefined): value is DurableControlMessage {
  if (hasExactKeys(value, ['type', 'runtimeRecord', 'leaderIncarnation', 'childRoot']) && value.type === 'runtime') {
    return (
      isDurableRuntimeRecord(value.runtimeRecord) &&
      value.runtimeRecord.pid === expectedPid &&
      (value.leaderIncarnation === null || isProcessIncarnation(value.leaderIncarnation)) &&
      (value.childRoot === null || isRecordedProcessIdentity(value.childRoot))
    );
  }
  return hasExactKeys(value, ['type', 'exitRecord']) && value.type === 'exit' && isExitRecord(value.exitRecord);
}

export function waitForDurableRuntime(options: { time: TimePort; wrapper: ReturnType<typeof spawnChild> }): Promise<{
  runtimeRecord: DurableCliRuntimeRecord;
  reportedLeaderIncarnation: ProcessIncarnation | null;
  childRoot: RecordedProcessIdentity | null;
  exitPromise: Promise<DurableProcessExit>;
}> {
  const stdout = options.wrapper.stdout;
  const stderr = options.wrapper.stderr;
  if (!stdout || !stderr) {
    throw new Error('Durable wrapper control pipes are unavailable');
  }

  stdout.setEncoding('utf8');
  stderr.setEncoding('utf8');

  const runtimeDeferred = createDeferred<DurableCliRuntimeRecord>();
  const exitDeferred = createDeferred<DurableProcessExit>();
  void exitDeferred.promise.catch(() => undefined);
  let runtimeRecord: DurableCliRuntimeRecord | null = null;
  let reportedLeaderIncarnation: ProcessIncarnation | null = null;
  let childRoot: RecordedProcessIdentity | null = null;
  let exitRecord: DurableProcessExit | null = null;
  let stderrBuffer = '';
  let stderrTruncated = false;
  let lineBuffer = '';
  let controlFailed = false;

  const buildError = (detail: string): Error => new Error(`${detail}${trimStderr(stderrBuffer)}`);
  const rejectControl = (error: Error): void => {
    if (controlFailed) return;
    controlFailed = true;
    if (runtimeRecord === null) runtimeDeferred.reject(error);
    else exitDeferred.reject(error);
  };

  const handleControlLine = (line: string): void => {
    if (line.trim().length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      rejectControl(buildError(`Durable wrapper emitted invalid control JSON (${errorMessage(error)})`));
      return;
    }

    if (!isDurableControlMessage(parsed, options.wrapper.pid)) {
      rejectControl(buildError('Durable wrapper emitted an invalid control message'));
      return;
    }

    const message = parsed;
    if (message.type === 'runtime') {
      runtimeRecord = message.runtimeRecord;
      reportedLeaderIncarnation = message.leaderIncarnation;
      childRoot = message.childRoot;
      runtimeDeferred.resolve(message.runtimeRecord);
      return;
    }

    exitRecord = message.exitRecord;
  };

  stdout.on('data', (chunk: string | Buffer) => {
    if (controlFailed) return;
    const text = chunk.toString();
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset);
      const end = newline === -1 ? text.length : newline;
      const segment = text.slice(offset, end);
      if (lineBuffer.length + segment.length > MAX_BUFFER) {
        lineBuffer = '';
        rejectControl(buildError(`Durable wrapper control line exceeded the ${MAX_BUFFER}-character limit`));
        return;
      }
      lineBuffer += segment;
      if (newline === -1) return;
      const line = lineBuffer;
      lineBuffer = '';
      handleControlLine(line);
      if (controlFailed) return;
      offset = newline + 1;
    }
  });

  stderr.on('data', (chunk: string | Buffer) => {
    if (stderrTruncated) return;
    const text = chunk.toString();
    const suffix = '\n[stderr truncated at buffer limit]';
    const remaining = MAX_BUFFER - suffix.length - stderrBuffer.length;
    if (text.length <= remaining) {
      stderrBuffer += text;
      return;
    }
    stderrBuffer += text.slice(0, Math.max(0, remaining)) + suffix;
    stderrTruncated = true;
  });

  options.wrapper.on('error', (error: Error) => {
    rejectControl(buildError(`Durable wrapper failed: ${error.message}`));
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

    if (exitRecord !== null) {
      exitDeferred.resolve(exitRecord);
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

  let readinessDeadline = options.time.monotonicNow() + BigInt(DURABLE_POLL_TIMEOUT_MS);
  let requestedWake = readinessDeadline;
  let postWakeTurnPending = false;
  let timeout: ReturnType<TimePort['setTimeout']> | null = null;
  const armReadinessCheck = (delayMs: number): void => {
    requestedWake = options.time.monotonicNow() + BigInt(delayMs);
    timeout = options.time.setTimeout(checkReadinessDeadline, delayMs);
    timeout.unref?.();
  };
  function checkReadinessDeadline(): void {
    if (runtimeRecord !== null || controlFailed) return;
    const now = options.time.monotonicNow();
    if (!postWakeTurnPending && now > requestedWake) {
      readinessDeadline += now - requestedWake;
    }
    if (now < readinessDeadline) {
      armReadinessCheck(Number(readinessDeadline - now));
      return;
    }
    if (!postWakeTurnPending) {
      postWakeTurnPending = true;
      armReadinessCheck(0);
      return;
    }
    rejectControl(buildError(`Durable wrapper failed to report runtime within ${DURABLE_POLL_TIMEOUT_MS}ms`));
  }
  armReadinessCheck(DURABLE_POLL_TIMEOUT_MS);

  return runtimeDeferred.promise
    .finally(() => options.time.clearTimeout(timeout))
    .then((record) => {
      return {
        runtimeRecord: record,
        reportedLeaderIncarnation,
        childRoot,
        exitPromise: exitDeferred.promise,
      };
    });
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
    (error as NodeJS.ErrnoException).code !== EXEC_MAXBUFFER_CODE
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
  let fd: number | null = null;
  try {
    fd = options?.mode === undefined ? openSync(tempPath, 'w') : openSync(tempPath, 'w', options.mode);
    if (options?.mode !== undefined) {
      fchmodSync(fd, options.mode);
    }
    writeAllSync(fd, normalizeStorageBuffer(data, options?.encoding ?? 'utf-8'));
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
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

async function syncDirectoryDurableAsync(path: string): Promise<boolean> {
  let directory: Awaited<ReturnType<typeof openAsync>> | null = null;
  try {
    directory = await openAsync(path, 'r');
    await directory.sync();
    return true;
  } catch {
    return false;
  } finally {
    await directory?.close().catch(() => {});
  }
}
