import { basename, join } from 'node:path';

import type { ProcessIncarnation } from '../infra/node-process.js';
import type { ChildProcessLike } from '../infra/port-types.js';
import {
  gracefulKill,
  observeUnattributableSpawnedProcessGroup,
  type GracefulKillOutcome,
  type GracefulKillPendingDisposition,
  type SpawnedProcessGroupAbsenceEvidence,
} from '../infra/process-supervision.js';
import type { Runtime } from '../runtime/ports.js';
import {
  connectControlClient,
  type ControlClient,
  type ControlClientTimer,
  type ProviderEventHandler,
} from './control-client.js';
import type { ControlEndpointTimer } from './control-endpoint.js';
import { PROVIDER_ROLE_FLAGS, type ProviderRole } from './role-argv.js';

/**
 * The shared mechanics every role-spawning caller needs: launching one role process from the existing
 * backend artifact, and reaching the control endpoint it will eventually bind. Both the coordinator and the
 * guardian's own role main go through this file rather than each re-deriving the artifact path or
 * re-implementing a connect retry loop.
 */

/** Reverse of `PROVIDER_ROLE_FLAGS`, derived rather than hand-copied so a role added to the flag table stays spawnable. */
const ROLE_FLAG_BY_ROLE: Readonly<Record<ProviderRole, string>> = Object.freeze(
  Object.fromEntries(Object.entries(PROVIDER_ROLE_FLAGS).map(([flag, role]) => [role, flag])) as Record<
    ProviderRole,
    string
  >,
);

export type RoleSpawnErrorCode = 'role_spawn_no_pid' | 'role_spawn_incarnation_unavailable';

export class RoleSpawnError extends Error {
  readonly code: RoleSpawnErrorCode;
  readonly role: ProviderRole;

  constructor(code: RoleSpawnErrorCode, role: ProviderRole, message: string) {
    super(message);
    this.name = 'RoleSpawnError';
    this.code = code;
    this.role = role;
    Object.setPrototypeOf(this, RoleSpawnError.prototype);
  }
}

export type RoleSpawnPorts = Readonly<{
  process: Pick<Runtime['process'], 'spawn'>;
  runtime: Runtime;
  platform: NodeJS.Platform;
  /** Injected so a test can fake a spawned pid's incarnation without a real process existing. */
  readProcessIncarnation?(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
}>;

export type RoleSpawnOptions = Readonly<{
  pluginRoot: string;
  /** `true` makes the child a new process-group leader; `false` for an ordinary child that inherits its
   *  parent's group. */
  detached: boolean;
  envAdditions?: Record<string, string>;
  /** Overrides "am I already running as the backend artifact"; defaults to `process.argv[1]`. */
  currentEntrypoint?: string;
  /** Overrides the node executable used to re-invoke the artifact; defaults to `process.execPath`. */
  command?: string;
}>;

export type SpawnedRoleProcess = Readonly<{
  kind: 'spawned';
  child: ChildProcessLike;
  pid: number;
  incarnation: ProcessIncarnation;
  /**
   * Rejects if this child later emits an async spawn error (Node reports ENOENT/EACCES this way, after the
   * synchronous `spawn()` call above already returned a pid); never settles otherwise. A caller races this
   * against its own readiness wait so a failure Node reports asynchronously surfaces there as a rejected
   * promise, not as an uncaught exception in this process — the same race `kb-daemon-supervisor.ts` runs
   * against its own spawned child's `'error'` event.
   */
  spawnFailed: Promise<never>;
}>;

type HeldRoleSpawnFor<Subject extends RoleSpawnCleanupSubject> = Readonly<{
  kind: 'held';
  child: ChildProcessLike;
  error: RoleSpawnError;
  subject: Subject;
  settled: Promise<void>;
  operatorExit: RoleSpawnOperatorExit<Subject>;
  retry(signal?: AbortSignal): Promise<RoleSpawnCleanupDisposition<Subject>>;
}>;

export type RoleSpawnCleanupSubject =
  | Readonly<{ kind: 'process'; pid: number | null }>
  | Readonly<{ kind: 'unattributable-process-group'; processGroupId: number | null }>;

export type RoleSpawnOperatorAbandonment<Subject extends RoleSpawnCleanupSubject> = Readonly<{
  kind: 'operator-abandoned';
  subject: Subject;
  processAbsenceProven: false;
  successor: Readonly<{ owner: 'operator-command'; acceptance: 'accepted' }>;
}>;

export type RoleSpawnOperatorExit<Subject extends RoleSpawnCleanupSubject> = Readonly<{
  kind: 'abandon-provider-proxy-acquisition';
  subject: Subject;
  abandon(): RoleSpawnOperatorAbandonment<Subject>;
}>;

type HeldRoleSpawnVariants<Subject extends RoleSpawnCleanupSubject> = Subject extends RoleSpawnCleanupSubject
  ? HeldRoleSpawnFor<Subject>
  : never;

export type HeldRoleSpawn = HeldRoleSpawnVariants<RoleSpawnCleanupSubject>;

export type RoleSpawnDisposition = SpawnedRoleProcess | HeldRoleSpawn;

const roleSpawnAbsenceEvidenceBrand: unique symbol = Symbol('coral.provider-proxy.role-spawn-absence');

type RoleSpawnProcessSubject = Extract<RoleSpawnCleanupSubject, { kind: 'process' }>;
type RoleSpawnUnattributableProcessGroupSubject = Extract<
  RoleSpawnCleanupSubject,
  { kind: 'unattributable-process-group' }
>;

type RoleSpawnUnattributableProcessGroupAbsenceEvidence<Subject extends RoleSpawnUnattributableProcessGroupSubject> =
  Readonly<{
    subject: Subject;
    processGroupEvidence: SpawnedProcessGroupAbsenceEvidence;
    [roleSpawnAbsenceEvidenceBrand]: true;
  }>;

export type RoleSpawnAbsenceEvidence<Subject extends RoleSpawnCleanupSubject = RoleSpawnCleanupSubject> =
  Subject extends Extract<RoleSpawnCleanupSubject, { kind: 'process' }>
    ? Readonly<{
        subject: Subject;
        [roleSpawnAbsenceEvidenceBrand]: true;
      }>
    : Subject extends RoleSpawnUnattributableProcessGroupSubject
      ? RoleSpawnUnattributableProcessGroupAbsenceEvidence<Subject>
      : never;

export type RoleSpawnCleanupDisposition<Subject extends RoleSpawnCleanupSubject = RoleSpawnCleanupSubject> =
  | Readonly<{
      kind: 'observed-absent';
      evidence: RoleSpawnAbsenceEvidence<Subject>;
    }>
  | Readonly<{
      kind: 'held-alive';
      subject: Subject;
      observation: 'alive';
      operatorExit: RoleSpawnOperatorExit<Subject>;
      settled: Promise<void>;
      retry(signal?: AbortSignal): Promise<RoleSpawnCleanupDisposition<Subject>>;
    }>
  | Readonly<{
      kind: 'held-unobservable';
      subject: Subject;
      observation: 'unobservable';
      operatorExit: RoleSpawnOperatorExit<Subject>;
      settled: Promise<void>;
      retry(signal?: AbortSignal): Promise<RoleSpawnCleanupDisposition<Subject>>;
    }>;

/** Mirrors `kb-daemon-supervisor.ts`'s own entrypoint resolution: reuse the artifact already running when
 *  its basename matches, otherwise resolve it under the plugin root's bundled bridge. */
function resolveBackendArtifact(pluginRoot: string, currentEntrypoint: string | undefined): string {
  if (typeof currentEntrypoint === 'string' && basename(currentEntrypoint) === 'coral-backend.cjs') {
    return currentEntrypoint;
  }
  return join(pluginRoot, 'bridge', 'coral-backend.cjs');
}

/** A failed role spawn remains owned until exact absence or accepted operator abandonment. */
export function spawnRoleProcess(
  role: ProviderRole,
  capsulePath: string,
  ports: RoleSpawnPorts,
  options: RoleSpawnOptions,
): RoleSpawnDisposition {
  const entrypoint = resolveBackendArtifact(options.pluginRoot, options.currentEntrypoint ?? process.argv[1]);
  const command = options.command ?? process.execPath;
  const child = ports.process.spawn({
    command,
    args: [entrypoint, ROLE_FLAG_BY_ROLE[role], capsulePath],
    cwd: options.pluginRoot,
    envAdditions: options.envAdditions ?? {},
    detached: options.detached,
  });

  // Attached unconditionally and first: Node reports ENOENT/EACCES asynchronously on this event, and an
  // EventEmitter with no listener re-throws it as an uncaught exception in *this* process — the coordinator,
  // when this spawns the guardian, or the guardian, when this spawns the reaper or the proxy. The internal
  // `.catch` keeps an uncollected `spawnFailed` from itself becoming an unhandled rejection on the failure
  // paths below that throw before a caller ever gets the chance to observe it.
  const spawnFailed = new Promise<never>((_resolve, reject) => {
    child.on('error', reject);
  });
  spawnFailed.catch(() => {});

  let childClosed = false;
  const childSettled = new Promise<void>((resolve) => {
    child.on('close', () => {
      childClosed = true;
      resolve();
    });
  });
  let killInFlight: GracefulKillPendingDisposition | null = null;
  let killOutcome: GracefulKillOutcome | null = null;
  // Piped output must be drained so a full OS pipe cannot block the child.
  child.stdout?.on('data', () => {});
  child.stdout?.on('error', () => {});
  child.stderr?.on('data', () => {});
  child.stderr?.on('error', () => {});
  const operatorExitFor = <Subject extends RoleSpawnCleanupSubject>(
    subject: Subject,
    acceptTransfer: () => void = () => undefined,
  ): RoleSpawnOperatorExit<Subject> => ({
    kind: 'abandon-provider-proxy-acquisition',
    subject,
    abandon: () => {
      acceptTransfer();
      return {
        kind: 'operator-abandoned',
        subject,
        processAbsenceProven: false,
        successor: { owner: 'operator-command', acceptance: 'accepted' },
      };
    },
  });
  const observedProcessAbsent = (
    subject: RoleSpawnProcessSubject,
  ): Extract<RoleSpawnCleanupDisposition<RoleSpawnProcessSubject>, { kind: 'observed-absent' }> => ({
    kind: 'observed-absent',
    evidence: Object.freeze({ subject, [roleSpawnAbsenceEvidenceBrand]: true as const }),
  });
  const holdFailedSpawn = (error: RoleSpawnError): HeldRoleSpawn => {
    if (options.detached) {
      const subject = { kind: 'unattributable-process-group', processGroupId: child.pid ?? null } as const;
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      const operatorExit = operatorExitFor(subject, resolveSettled);
      const retry = async (_signal?: AbortSignal): Promise<RoleSpawnCleanupDisposition<typeof subject>> => {
        if (subject.processGroupId !== null) {
          const observation = observeUnattributableSpawnedProcessGroup(subject.processGroupId, ports.runtime);
          if (observation.kind === 'observed-absent') {
            resolveSettled();
            return {
              kind: 'observed-absent',
              evidence: Object.freeze({
                subject,
                processGroupEvidence: observation.evidence,
                [roleSpawnAbsenceEvidenceBrand]: true as const,
              }),
            };
          }
        }
        return {
          kind: 'held-unobservable',
          subject,
          observation: 'unobservable',
          operatorExit,
          settled,
          retry,
        };
      };
      return { kind: 'held', child, error, subject, settled, operatorExit, retry };
    }

    const subject = { kind: 'process', pid: child.pid ?? null } as const;
    const operatorExit = operatorExitFor(subject);
    const retry = async (signal?: AbortSignal): Promise<RoleSpawnCleanupDisposition<typeof subject>> => {
      if (childClosed) return observedProcessAbsent(subject);
      if (killOutcome?.kind === 'observed-absent') return observedProcessAbsent(subject);
      if (signal?.aborted) {
        return {
          kind: 'held-unobservable',
          subject,
          observation: 'unobservable',
          operatorExit,
          settled: childSettled,
          retry,
        };
      }
      if (killInFlight === null) {
        const disposition = gracefulKill(child, ports.runtime, (pid) => ports.runtime.process.observeLiveness(pid));
        if ('settlement' in disposition) {
          killInFlight = disposition;
          void disposition.settlement.then((outcome) => {
            if (killInFlight === disposition) {
              killInFlight = null;
              killOutcome = outcome;
            }
          });
        } else {
          killOutcome = disposition;
        }
      }
      if (childClosed) return observedProcessAbsent(subject);
      if (typeof child.pid === 'number') {
        try {
          const observation = ports.runtime.process.observeLiveness(child.pid);
          if (childClosed) return observedProcessAbsent(subject);
          if (observation === 'absent') return observedProcessAbsent(subject);
          if (observation === 'alive') {
            return { kind: 'held-alive', subject, observation, operatorExit, settled: childSettled, retry };
          }
        } catch {
          // A close observation remains required when leader liveness cannot answer.
        }
      }
      if (childClosed) return observedProcessAbsent(subject);
      return {
        kind: 'held-unobservable',
        subject,
        observation: 'unobservable',
        operatorExit,
        settled: childSettled,
        retry,
      };
    };
    return { kind: 'held', child, error, subject, settled: childSettled, operatorExit, retry };
  };

  if (typeof child.pid !== 'number') {
    return holdFailedSpawn(
      new RoleSpawnError('role_spawn_no_pid', role, `Spawning the ${role} role did not return a pid.`),
    );
  }

  const readIncarnation = ports.readProcessIncarnation ?? ports.runtime.process.readProcessIncarnation;
  let incarnation: ProcessIncarnation | null;
  try {
    incarnation = readIncarnation(child.pid, ports.platform);
  } catch {
    incarnation = null;
  }
  if (incarnation === null) {
    return holdFailedSpawn(
      new RoleSpawnError(
        'role_spawn_incarnation_unavailable',
        role,
        `Could not read the incarnation of the spawned ${role} process (pid ${child.pid}).`,
      ),
    );
  }

  // Only an incarnation-bound role may stop keeping its current owner alive.
  child.unref?.();
  return { kind: 'spawned', child, pid: child.pid, incarnation, spawnFailed };
}

/** A held role cannot be translated into spawn success or failure until exact-subject absence is observed. */
export async function requireSpawnedRole(disposition: RoleSpawnDisposition): Promise<RoleSpawnDisposition> {
  if (disposition.kind === 'spawned') return disposition;
  const cleanup = await disposition.retry();
  if (cleanup.kind !== 'observed-absent') return disposition;
  throw disposition.error;
}

export function runtimeControlTimer(runtime: Pick<Runtime, 'time'>): ControlEndpointTimer & ControlClientTimer {
  return {
    setTimeout: (callback, ms) => runtime.time.setTimeout(callback, ms),
    clearTimeout: (handle) => runtime.time.clearTimeout(handle),
  };
}

export type RoleConnectRetryOptions = Readonly<{
  connectTimeoutMs: number;
  retryIntervalMs: number;
  overallDeadlineMs: number;
  monotonicNow(): bigint;
  sleep(ms: number): Promise<void>;
}>;

/**
 * Connects to a freshly spawned role's control endpoint, retrying until it is reachable or the overall
 * budget elapses. A spawn call returns as soon as the OS has scheduled the process, not once it has bound
 * its socket — so the first connect attempt legitimately racing a not-yet-listening peer is the ordinary
 * case, not a failure.
 *
 * `onProviderEvent`, when supplied, answers the one inbound method this connection may ever receive:
 * `provider.event.v1`. Only the proxy role ever pushes it (`protocol.ts`'s own doc), so only the caller
 * connecting to a proxy endpoint has a reason to pass one.
 */
export async function connectRoleControlWithRetry(
  socketPath: string,
  timer: ControlClientTimer,
  options: RoleConnectRetryOptions,
  onProviderEvent?: ProviderEventHandler,
): Promise<ControlClient> {
  // This budget bounds our own retrying, so it spends real elapsed time: charging only a poll cadence per
  // attempt would let a slow connect attempt stretch the deadline without limit, and a retry that cannot
  // exhaust is not an exit.
  const deadlineMonotonicMs = options.monotonicNow() + BigInt(options.overallDeadlineMs);
  while (true) {
    try {
      return await connectControlClient(socketPath, timer, options.connectTimeoutMs, onProviderEvent);
    } catch (error: unknown) {
      if (options.monotonicNow() >= deadlineMonotonicMs) throw error;
      await options.sleep(options.retryIntervalMs);
    }
  }
}
