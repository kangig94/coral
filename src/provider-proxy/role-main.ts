import { z } from 'zod';

import { BUILD_FLAVOR_ENV_KEY, resolveBuildFlavor } from '../infra/build-flavor.js';
import { backendLog } from '../infra/backend-log.js';
import type { StrictBundleIdentityResult } from '../infra/bundle-manifest.js';
import { createMonotonicClock, type MonotonicClock } from '../infra/monotonic-clock.js';
import {
  snapshotProcessIncarnationProbeSubjects,
  terminateProcessIncarnationProbes,
  type AsyncRecordedProcessObserver,
  type ProcessIncarnation,
  type ProcessIncarnationProbeHold,
  type ProcessIncarnationProbeSubject,
} from '../infra/node-process.js';
import { providerProxyBootstrapCapsulePath, providerReaperBootstrapCapsulePath } from '../infra/path/index.js';
import {
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '../infra/process-containment.js';
import { gracefulKillByPid, type GracefulKillByPidOutcome } from '../infra/process-supervision.js';
import {
  SettlementGate,
  type HeldSettlementDisposition,
  type SettledSettlementDisposition,
} from '../obligation/settlement.js';
import { createRealRuntime } from '../runtime/real.js';
import type { Runtime } from '../runtime/ports.js';
import {
  consumeProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProviderBootstrapCapsuleEnvironment,
} from './bootstrap-capsule.js';
import {
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  mintLocalSignalTeardownAuthorization,
  type EnforcementOutcome,
  type EnforcementScheduler,
  type LocalSignalTeardownDisposition,
} from './enforcement.js';
import { DETACHED_CONTAINMENT_KIND, createGuardian, type Guardian } from './guardian.js';
import { createControlHolderAuthority, type ControlHolderAuthority } from './holder-lifecycle.js';
import type { ProviderOperationKey } from './ledger.js';
import {
  createEnforcerDeadlineStateMachine,
  CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV,
  PROXY_TEARDOWN_RESERVE_MS,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerDeadlineStateMachine,
  type ProviderProxyDeadlineConfiguration,
} from './orphan-deadline.js';
import type { OperationStageHandle } from './operation-supervisor.js';
import type { ControlClient, ControlExchange } from './control-client.js';
import {
  guardianRegisterProviderRootParamsSchema,
  GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE,
  guardianProxyOperationReleaseParamsSchema,
  guardianProxyOperationReleaseResultSchema,
  jointContainmentReceiptSchema,
  providerRootSchema,
  ProxyControlProtocolError,
  reservationSchema,
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  controlPairParamsSchema,
  controlPairResultSchema,
  enforcementHoldStatusSchema,
  type JointContainmentReceipt,
  type ProxyIdentity,
  type ProxyPreparedAppServerOperation,
} from './protocol.js';
import { createProxy, type Proxy, type ProxyOptions } from './proxy.js';
import { createReaper, type Reaper } from './reaper.js';
import { createProxyAppServerHostAuthority } from './provider-root-authority.js';
import { createSemanticOperationRuntime, type SemanticOperationStageHandle } from './semantic-operation-runner.js';
import {
  connectRoleControlWithRetry,
  requireSpawnedRole,
  runtimeControlTimer,
  spawnRoleProcess,
  type HeldRoleSpawn,
  type RoleSpawnCleanupSubject,
  type RoleSpawnPorts,
  type SpawnedRoleProcess,
} from './role-spawn.js';
import type { ProviderRoleArgv } from './role-argv.js';

function requireRolePeerResult(method: string, exchange: ControlExchange): unknown {
  if (exchange.kind === 'response') {
    if (exchange.response.kind === 'result') return exchange.response.value;
    throw exchange.response.error;
  }
  if (exchange.error instanceof Error) throw exchange.error;
  throw new Error(`${method} could not be sent.`, { cause: exchange.error });
}

/**
 * Runs one provider-role process: guardian, reaper, or proxy.
 *
 * The spawn topology this file drives has a circular dependency the reaper already shows the shape of: the
 * guardian creates the proxy containment by spawning it, but must already be listening before the proxy can
 * connect — so its enforcer arms from `guardian.recordContainment`, not from construction, exactly mirroring
 * how the reaper's enforcer arms from `reaper.record-containment.v1` rather than from its own construction.
 */

/** How long a role main waits for a just-spawned peer to bind its control socket before giving up. A spawn
 *  call returns as soon as the OS has scheduled the process, not once it is listening. */
const ROLE_SPAWN_READY_DEADLINE_MS = 10_000;
const ROLE_SPAWN_READY_RETRY_INTERVAL_MS = 20;
const ROLE_CONNECT_TIMEOUT_MS = 2_000;

// One `unique symbol` per role clock, so a clock built for one role's containment can never type-check as
// interchangeable with another's — each is its own process-local authority.
const guardianConstructionUnwindClockScope: unique symbol = Symbol('coral.provider-proxy.guardian-unwind');
const guardianRoleClockScope: unique symbol = Symbol('coral.provider-proxy.guardian');
const reaperRoleClockScope: unique symbol = Symbol('coral.provider-proxy.reaper');
const proxyRoleClockScope: unique symbol = Symbol('coral.provider-proxy.proxy');

export type ProviderRoleMainPorts = Readonly<{
  runtime: Runtime;
  pluginRoot: string;
  /** Overrides the capsule/endpoint path base directory; defaults to the real `~/.coral` tree. Tests pass a
   *  scoped temp directory so they never touch real user state. */
  baseDir?: string;
  /** Injected for tests; defaults to the real embedded-vs-adjacent-manifest strict identity check. */
  resolveStrictIdentity?(): StrictBundleIdentityResult;
  readProcessIncarnation?(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
  observeRecordedProcessAsync?: AsyncRecordedProcessObserver;
  /** Injected for tests; defaults to the real `process.exit`. Called once a guardian or reaper's enforcement
   *  outcome has settled and its own control has closed — its only reason to keep running was bounding one
   *  containment, and there is nothing left to bound once teardown is done. */
  exitProcess?(code: number): void;
  /** Test-only observation hook: called the instant the guardian's `listen()` resolves, strictly before the
   *  proxy is spawned. Exists so a test can record a sequence number here and at the spawn call and assert
   *  the ordering directly, rather than via an assertion that would hold whichever order actually ran. */
  onGuardianListening?(): void;
}>;

function buildCapsuleEnv(ports: ProviderRoleMainPorts): ProviderBootstrapCapsuleEnvironment {
  return {
    storage: ports.runtime.storage,
    uid: process.getuid?.() ?? 0,
    ...(ports.resolveStrictIdentity === undefined ? {} : { resolveStrictIdentity: ports.resolveStrictIdentity }),
  };
}

function buildScheduler(runtime: Runtime): EnforcementScheduler {
  return {
    schedule: (callback, ms) => runtime.time.setTimeout(callback, ms),
    cancel: (handle) => runtime.time.clearTimeout(handle),
  };
}

function buildContainmentEnvironment<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  ports: ProviderRoleMainPorts,
): ProcessContainmentEnvironment<Scope> {
  return {
    maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
    clock,
    process: {
      kill: ports.runtime.process.kill,
      observeLiveness: ports.runtime.process.observeLiveness,
      observeRecordedProcessAsync:
        ports.observeRecordedProcessAsync ?? ports.runtime.process.observeRecordedProcessAsync,
    },
    platform: ports.runtime.env.platform() as NodeJS.Platform,
    readProcessIncarnation: ports.readProcessIncarnation ?? ports.runtime.process.readProcessIncarnation,
  };
}

function buildDeadlines<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  configuration: ProviderProxyDeadlineConfiguration,
  ports: ProviderRoleMainPorts,
  holderAuthority: ControlHolderAuthority,
): EnforcerDeadlineStateMachine<Scope> {
  return createEnforcerDeadlineStateMachine(
    clock,
    configuration,
    { mintChallenge: () => ports.runtime.ids.uuid() },
    holderAuthority,
  );
}

function buildHolderObserver(ports: ProviderRoleMainPorts): AsyncRecordedProcessObserver {
  return ports.observeRecordedProcessAsync ?? ports.runtime.process.observeRecordedProcessAsync;
}

function buildSpawnPorts(ports: ProviderRoleMainPorts): RoleSpawnPorts {
  return {
    process: ports.runtime.process,
    runtime: ports.runtime,
    platform: ports.runtime.env.platform() as NodeJS.Platform,
    readProcessIncarnation: ports.readProcessIncarnation ?? ports.runtime.process.readProcessIncarnation,
  };
}

/** Close-and-exit deferral and hold retries must use the injected scheduler. */
type RoleOutcomeScheduler = (callback: () => void, delayMs: number) => void;

function realRoleOutcomeScheduler(ports: ProviderRoleMainPorts): RoleOutcomeScheduler {
  return (callback, delayMs) => {
    const handle = ports.runtime.time.setTimeout(callback, delayMs);
    handle.unref?.();
  };
}

/** This role's own pid and incarnation. A role that cannot read its own incarnation cannot construct an
 *  identity anyone else could later verify against, so it fails rather than reporting a bare pid. */
function readSelfIdentity(ports: ProviderRoleMainPorts): Readonly<{ pid: number; incarnation: ProcessIncarnation }> {
  const pid = ports.runtime.env.pid();
  const platform = ports.runtime.env.platform() as NodeJS.Platform;
  const read = ports.readProcessIncarnation ?? ports.runtime.process.readProcessIncarnation;
  const incarnation = read(pid, platform);
  if (incarnation === null) {
    throw new Error(`Could not read this process's own incarnation (pid ${pid}).`);
  }
  return { pid, incarnation };
}

function reaperCapsulePathFrom(capsule: GuardianBootstrapCapsule, baseDir: string | undefined): string {
  return providerReaperBootstrapCapsulePath(
    {
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      reaperInstanceId: capsule.reaperInstanceId,
    },
    { baseDir },
  );
}

function proxyCapsulePathFrom(capsule: GuardianBootstrapCapsule, baseDir: string | undefined): string {
  return providerProxyBootstrapCapsulePath(
    {
      generation: capsule.generation,
      flavor: capsule.flavor,
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      proxyInstanceId: capsule.proxyInstanceId,
    },
    { baseDir },
  );
}

export type GuardianRoleHandle = Readonly<{
  role: 'guardian';
  guardian: Guardian;
  reaperSpawn: SpawnedRoleProcess;
  proxySpawn: SpawnedRoleProcess;
  close(): Promise<void>;
  /** Ordinary teardown must not authorize abandonment of an unattributable hold. */
  giveUp(): Promise<LocalSignalTeardownDisposition>;
}>;

export type ReaperSignalTeardownDisposition =
  | LocalSignalTeardownDisposition
  | Readonly<{ kind: 'closed-without-containment' }>;

export type ReaperRoleHandle = Readonly<{
  role: 'reaper';
  reaper: Reaper;
  close(): Promise<void>;
  /** Ordinary teardown must not authorize abandonment of an unattributable hold. */
  giveUp(): Promise<ReaperSignalTeardownDisposition>;
}>;

export type ProxyRoleHandle = Readonly<{
  role: 'proxy';
  proxy: Proxy;
  close(): Promise<void>;
}>;

export type ProviderRoleHandle = GuardianRoleHandle | ReaperRoleHandle | ProxyRoleHandle;

type GuardianConstructionProxyProcessGroupSubject = Readonly<{
  kind: 'proxy-process-group';
  identity: RecordedContainmentIdentity;
}>;

type GuardianConstructionReaperProcessSubject = Readonly<{
  kind: 'reaper-process';
  identity: RecordedProcessIdentity;
}>;

type GuardianConstructionOperatorSubject =
  | GuardianConstructionProxyProcessGroupSubject
  | GuardianConstructionReaperProcessSubject;

type GuardianConstructionOperatorExit<Subject extends GuardianConstructionOperatorSubject> = Readonly<{
  kind: 'abandon-guardian-construction-cleanup';
  subject: Subject;
  abandon(): Readonly<{
    kind: 'operator-abandoned';
    subject: Subject;
    processAbsenceProven: false;
    successor: Readonly<{ owner: 'operator-command'; acceptance: 'accepted' }>;
  }>;
}>;

type GuardianConstructionCleanupObligation =
  | Readonly<{
      kind: 'proxy-process-group';
      identity: RecordedContainmentIdentity;
      operatorExit: GuardianConstructionOperatorExit<GuardianConstructionProxyProcessGroupSubject>;
      reason: string;
    }>
  | Readonly<{
      kind: 'reaper-process';
      identity: RecordedProcessIdentity;
      operatorExit: GuardianConstructionOperatorExit<GuardianConstructionReaperProcessSubject>;
      reason: string;
    }>
  | Readonly<{
      kind: 'failed-role-spawn';
      subject: RoleSpawnCleanupSubject;
      operatorExit: HeldRoleSpawn['operatorExit'];
      settled: Promise<void>;
      reason: string;
    }>;

function guardianConstructionOperatorExit<Subject extends GuardianConstructionOperatorSubject>(
  subject: Subject,
): GuardianConstructionOperatorExit<Subject> {
  return {
    kind: 'abandon-guardian-construction-cleanup',
    subject,
    abandon: () => ({
      kind: 'operator-abandoned',
      subject,
      processAbsenceProven: false,
      successor: { owner: 'operator-command', acceptance: 'accepted' },
    }),
  };
}

export type GuardianConstructionCleanupDisposition =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{
      kind: 'holding';
      pending: readonly [GuardianConstructionCleanupObligation, ...GuardianConstructionCleanupObligation[]];
      reason: string;
      retry(): Promise<GuardianConstructionCleanupDisposition>;
    }>;

function guardianConstructionCleanupHoldDetail(
  disposition: Extract<GuardianConstructionCleanupDisposition, { kind: 'holding' }>,
): string {
  return disposition.pending
    .map((obligation) => {
      switch (obligation.kind) {
        case 'proxy-process-group':
          return (
            `proxy-process-group pgid=${obligation.identity.processGroupId} pid=${obligation.identity.pid} ` +
            `incarnation=${obligation.identity.incarnation} reason=${obligation.reason}`
          );
        case 'reaper-process':
          return (
            `reaper-process pid=${obligation.identity.pid} incarnation=${obligation.identity.incarnation} ` +
            `reason=${obligation.reason}`
          );
        case 'failed-role-spawn':
          return obligation.subject.kind === 'process'
            ? `failed-role-spawn process pid=${obligation.subject.pid ?? 'unavailable'} reason=${obligation.reason}`
            : `failed-role-spawn process-group pgid=${obligation.subject.processGroupId ?? 'unavailable'} reason=${obligation.reason}`;
      }
    })
    .join('; ');
}

function combineGuardianConstructionCleanup(
  dispositions: readonly GuardianConstructionCleanupDisposition[],
): GuardianConstructionCleanupDisposition {
  const holding = dispositions.filter(
    (disposition): disposition is Extract<GuardianConstructionCleanupDisposition, { kind: 'holding' }> =>
      disposition.kind === 'holding',
  );
  const [first, ...rest] = holding;
  if (first === undefined) return { kind: 'settled' };
  const pending: [GuardianConstructionCleanupObligation, ...GuardianConstructionCleanupObligation[]] = [
    ...first.pending,
    ...rest.flatMap((disposition) => disposition.pending),
  ];
  return {
    kind: 'holding',
    pending,
    reason: pending.map((obligation) => `${obligation.kind}: ${obligation.reason}`).join(', '),
    retry: async () => combineGuardianConstructionCleanup(await Promise.all(holding.map(({ retry }) => retry()))),
  };
}

function holdFailedRoleSpawn(spawn: HeldRoleSpawn): GuardianConstructionCleanupDisposition {
  const holding = (retry: HeldRoleSpawn['retry'], reason: string): GuardianConstructionCleanupDisposition => ({
    kind: 'holding',
    pending: [
      {
        kind: 'failed-role-spawn',
        subject: spawn.subject,
        operatorExit: spawn.operatorExit,
        settled: spawn.settled,
        reason,
      },
    ],
    reason,
    retry: async () => {
      const cleanup = await retry();
      if (cleanup.kind === 'observed-absent') return { kind: 'settled' };
      return {
        ...holding(cleanup.retry, `${cleanup.subject.kind}:${cleanup.observation}`),
        pending: [
          {
            kind: 'failed-role-spawn',
            subject: cleanup.subject,
            operatorExit: cleanup.operatorExit,
            settled: spawn.settled,
            reason: `${cleanup.subject.kind}:${cleanup.observation}`,
          },
        ],
      };
    },
  });
  return holding(spawn.retry, spawn.error.message);
}

/** A vanished or reused leader cannot prove that its detached process group is absent. */
async function reapUnheldProcessGroup<Scope extends symbol>(
  containment: RecordedContainmentIdentity,
  clock: MonotonicClock<Scope>,
  environment: ProcessContainmentEnvironment<Scope>,
): Promise<GuardianConstructionCleanupDisposition> {
  if (containment.processGroupId !== containment.pid) {
    throw new Error(
      `Recorded containment pid=${containment.pid} is not its own process-group leader (processGroupId=${containment.processGroupId}).`,
    );
  }
  const subject = { kind: 'proxy-process-group', identity: containment } as const;
  const operatorExit = guardianConstructionOperatorExit(subject);
  const holding = (reason: string): GuardianConstructionCleanupDisposition => ({
    kind: 'holding',
    pending: [{ ...subject, operatorExit, reason }],
    reason,
    retry,
  });
  async function retry(): Promise<GuardianConstructionCleanupDisposition> {
    try {
      const outcome = await reapRecordedContainment(
        containment,
        [],
        clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
        environment,
      );
      if (outcome.kind === 'containment-absent') return { kind: 'settled' };
      if (outcome.kind === 'recorded-group-unattributable') {
        return holding('the recorded proxy group became unattributable');
      }
      if (outcome.kind === 'identity-unobservable') {
        return holding(
          outcome.signalDelivered
            ? 'process identity became unobservable after a recorded proxy-group signal was delivered'
            : 'process identity could not be observed before recorded proxy-group signal authorization',
        );
      }
      return holding('signal authorization could not be established for the recorded proxy group');
    } catch (error: unknown) {
      return holding(error instanceof Error ? error.message : String(error));
    }
  }
  return retry();
}

function gracefulKillFailureDetail(outcome: Exclude<GracefulKillByPidOutcome, { kind: 'observed-absent' }>): string {
  switch (outcome.kind) {
    case 'signal-refused':
      return outcome.reason;
    case 'signal-delivered-escalation-unavailable':
      return `${outcome.signal}:${outcome.reason}`;
    case 'signal-failed':
      return `${outcome.signal}:${outcome.reason}`;
    case 'target-unobservable':
    case 'target-alive':
      return `${outcome.kind}:${outcome.stage}`;
  }
}

/** An undetached reaper remains a pid target and must not be promoted to a process-group identity. */
async function reapUnheldOrdinaryProcess(
  identity: RecordedProcessIdentity,
  ports: ProviderRoleMainPorts,
): Promise<GuardianConstructionCleanupDisposition> {
  const subject = { kind: 'reaper-process', identity } as const;
  const operatorExit = guardianConstructionOperatorExit(subject);
  const holding = (reason: string): GuardianConstructionCleanupDisposition => ({
    kind: 'holding',
    pending: [{ ...subject, operatorExit, reason }],
    reason,
    retry,
  });
  async function retry(): Promise<GuardianConstructionCleanupDisposition> {
    try {
      const readProcessIncarnation = ports.readProcessIncarnation ?? ports.runtime.process.readProcessIncarnation;
      const runtime: Runtime = {
        ...ports.runtime,
        process: { ...ports.runtime.process, readProcessIncarnation },
      };
      const disposition = gracefulKillByPid(runtime, identity.pid, identity.incarnation);
      const outcome = disposition.kind === 'escalation-scheduled' ? await disposition.settlement : disposition;
      if (outcome.kind === 'observed-absent') return { kind: 'settled' };
      if (outcome.kind === 'signal-refused' && outcome.reason === 'expected-incarnation-mismatch') {
        return { kind: 'settled' };
      }
      return holding(`Could not confirm pid=${identity.pid} exited (${gracefulKillFailureDetail(outcome)}).`);
    } catch (error: unknown) {
      return holding(error instanceof Error ? error.message : String(error));
    }
  }
  return retry();
}

/** A non-zero exit must not be read as confirmed containment absence. */
const ROLE_ENFORCEMENT_FAILURE_EXIT_CODE = 1;
const ROLE_UNATTRIBUTABLE_REAP_MAX_ATTEMPTS = 5;
const ROLE_UNATTRIBUTABLE_REAP_BASE_DELAY_MS = 1_000;
const ROLE_UNATTRIBUTABLE_REAP_MAX_DELAY_MS = 30_000;

type RoleEnforcementHoldStatus = z.infer<typeof enforcementHoldStatusSchema>;

export class GuardianConstructionCleanupHeldError extends Error {
  readonly hold: Extract<GuardianConstructionCleanupDisposition, { kind: 'holding' }>;

  constructor(originalFailure: unknown, hold: Extract<GuardianConstructionCleanupDisposition, { kind: 'holding' }>) {
    super(
      `Guardian construction failed while spawned process cleanup remains held: ${guardianConstructionCleanupHoldDetail(hold)}`,
      { cause: originalFailure },
    );
    this.name = 'GuardianConstructionCleanupHeldError';
    this.hold = hold;
    Object.setPrototypeOf(this, GuardianConstructionCleanupHeldError.prototype);
  }
}

const settledGuardianConstructionFailures = new WeakSet<object>();

function markGuardianConstructionCleanupSettled(error: unknown): unknown {
  const failure =
    (typeof error === 'object' && error !== null) || typeof error === 'function'
      ? error
      : new Error('Guardian construction failed after spawned process cleanup settled.', { cause: error });
  settledGuardianConstructionFailures.add(failure);
  return failure;
}

function isGuardianConstructionCleanupSettled(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    settledGuardianConstructionFailures.has(error)
  );
}

function acceptGuardianConstructionOperatorExit(
  disposition: Extract<GuardianConstructionCleanupDisposition, { kind: 'holding' }>,
): boolean {
  const subjectMatches = (obligation: GuardianConstructionCleanupObligation, subject: unknown): boolean => {
    if (typeof subject !== 'object' || subject === null || !('kind' in subject)) return false;
    if (obligation.kind === 'failed-role-spawn') {
      if (obligation.subject.kind !== subject.kind) return false;
      return obligation.subject.kind === 'process'
        ? 'pid' in subject && obligation.subject.pid === subject.pid
        : 'processGroupId' in subject && obligation.subject.processGroupId === subject.processGroupId;
    }
    if (obligation.kind !== subject.kind || !('identity' in subject)) return false;
    const identity = subject.identity;
    if (typeof identity !== 'object' || identity === null || !('pid' in identity) || !('incarnation' in identity)) {
      return false;
    }
    if (obligation.identity.pid !== identity.pid || obligation.identity.incarnation !== identity.incarnation) {
      return false;
    }
    return obligation.kind === 'reaper-process'
      ? true
      : 'processGroupId' in identity && obligation.identity.processGroupId === identity.processGroupId;
  };
  if (!disposition.pending.every((obligation) => subjectMatches(obligation, obligation.operatorExit.subject))) {
    return false;
  }
  const abandonments = disposition.pending.map(({ operatorExit }) => operatorExit.abandon());
  return disposition.pending.every((obligation, index) => {
    const abandonment = abandonments[index];
    if (
      abandonment === undefined ||
      abandonment.kind !== 'operator-abandoned' ||
      abandonment.processAbsenceProven !== false ||
      abandonment.successor.owner !== 'operator-command' ||
      abandonment.successor.acceptance !== 'accepted'
    ) {
      return false;
    }
    return subjectMatches(obligation, abandonment.subject);
  });
}

export type RoleEnforcementOutcomeHandlers = Readonly<{
  onOutcome(outcome: EnforcementOutcome): void;
  onProgressViolation(observedWakeLatencyMs: number): void;
  enforcementHoldStatus(): RoleEnforcementHoldStatus | null;
  abandonUnattributable(): boolean;
}>;

export type RoleEnforcementOutcomeOptions<Scope extends symbol> = Readonly<{
  role: 'guardian' | 'reaper';
  roleIdentity: Readonly<{ pid: number; incarnation: ProcessIncarnation }>;
  deadlines: Pick<EnforcerDeadlineStateMachine<Scope>, 'markExited'>;
  /** Closes this role's own control (and, for the guardian, its reaper pairing channel too). */
  close(): Promise<void>;
  exitProcess(code: number): void;
  grantWasInstalled(): boolean;
  now(): number;
  retryUnattributable(): Promise<EnforcementOutcome> | null;
  schedule: RoleOutcomeScheduler;
}>;

function unattributableRetryDelayMs(attempts: number): number {
  return Math.min(ROLE_UNATTRIBUTABLE_REAP_BASE_DELAY_MS * 2 ** (attempts - 1), ROLE_UNATTRIBUTABLE_REAP_MAX_DELAY_MS);
}

/**
 * Outcomes without confirmed absence must keep the role alive unless explicit operator authority abandons the hold.
 * Only confirmed absence may mark the deadline model exited. Close-and-exit must remain deferred so an
 * in-flight control response can reach its caller before the role closes its sockets.
 */
export function buildEnforcementOutcomeHandlers<Scope extends symbol>(
  options: RoleEnforcementOutcomeOptions<Scope>,
): RoleEnforcementOutcomeHandlers {
  let enforcementHoldStatus: RoleEnforcementHoldStatus | null = null;
  let unattributableAbandoned = false;

  const closeAndExit = (exitCode: number): void => {
    void options
      .close()
      .catch((error: unknown) => backendLog.error(`${options.role}: close on exit failed`, error))
      .finally(() => options.exitProcess(exitCode));
  };

  const handleOutcome = (outcome: EnforcementOutcome): void => {
    if (outcome.kind !== 'containment-absent') {
      if (unattributableAbandoned) return;
      if (outcome.kind === 'reap-failed') {
        backendLog.error(`${options.role}: containment reap failed`, outcome.reason);
      }
      const reportedOutcome =
        outcome.kind === 'reap-failed'
          ? ({ kind: outcome.kind, reason: 'process-containment-reap-failed' } as const)
          : ({ kind: outcome.kind } as const);
      const attempts = (enforcementHoldStatus?.attempts ?? 0) + 1;
      if (attempts >= ROLE_UNATTRIBUTABLE_REAP_MAX_ATTEMPTS && options.grantWasInstalled()) {
        enforcementHoldStatus = enforcementHoldStatusSchema.parse({
          ...reportedOutcome,
          attempts,
          roleIdentity: { role: options.role, ...options.roleIdentity },
          retry: { state: 'operator-action-required' },
        });
        return;
      }
      const delayMs = unattributableRetryDelayMs(attempts);
      enforcementHoldStatus = enforcementHoldStatusSchema.parse({
        ...reportedOutcome,
        attempts,
        roleIdentity: { role: options.role, ...options.roleIdentity },
        retry: { state: 'scheduled', nextProbeAtMs: options.now() + delayMs },
      });
      options.schedule(() => {
        if (
          unattributableAbandoned ||
          enforcementHoldStatus?.attempts !== attempts ||
          enforcementHoldStatus.retry.state !== 'scheduled'
        ) {
          return;
        }
        enforcementHoldStatus = enforcementHoldStatusSchema.parse({
          ...enforcementHoldStatus,
          retry: { state: 'in-progress' },
        });
        void options.retryUnattributable();
      }, delayMs);
      return;
    }

    enforcementHoldStatus = null;
    options.deadlines.markExited();
    closeAndExit(
      options.role === 'guardian' && !options.grantWasInstalled()
        ? GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE
        : 0,
    );
  };

  return {
    onOutcome: (outcome) => {
      options.schedule(() => handleOutcome(outcome), 0);
    },
    onProgressViolation: (observedWakeLatencyMs) => {
      // A late wake is diagnostic and does not itself authorize teardown.
      backendLog.warn(`${options.role}: enforcement wake exceeded the modelled bound by ${observedWakeLatencyMs}ms`);
    },
    enforcementHoldStatus: () => enforcementHoldStatus,
    abandonUnattributable: () => {
      if (enforcementHoldStatus === null || unattributableAbandoned) return false;
      if (enforcementHoldStatus.kind !== 'recorded-group-unattributable') {
        throw new ProxyControlProtocolError(
          'invalid_state',
          `This ${options.role} has a failed containment reap, not an unattributable recorded group. Retry the reap without relinquishing containment ownership.`,
        );
      }
      if (enforcementHoldStatus.retry.state === 'in-progress') {
        throw new ProxyControlProtocolError(
          'invalid_state',
          `This ${options.role} cannot abandon its unattributable hold while a retry is in-progress and may already have sent a process signal. Retry the abandonment after the containment retry settles.`,
        );
      }
      unattributableAbandoned = true;
      enforcementHoldStatus = null;
      options.schedule(() => closeAndExit(ROLE_ENFORCEMENT_FAILURE_EXIT_CODE), 0);
      return true;
    },
  };
}

/** Every created process remains owned until absence is confirmed or a retry capability retains it. */
async function unwindGuardianConstruction(
  ports: ProviderRoleMainPorts,
  partial: Readonly<{
    close: (() => Promise<void>) | null;
    reaperChannel: Pick<ControlClient, 'close'> | null;
    reaperSpawn: SpawnedRoleProcess | null;
    proxySpawn: SpawnedRoleProcess | null;
    failedRoleSpawn: HeldRoleSpawn | null;
  }>,
): Promise<GuardianConstructionCleanupDisposition> {
  const stranded: string[] = [];
  let proxyCleanup: GuardianConstructionCleanupDisposition = { kind: 'settled' };
  const attempt = async (label: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
    } catch (error: unknown) {
      stranded.push(label);
      backendLog.error(`guardian construction cleanup could not ${label}`, error);
    }
  };

  if (partial.close !== null) {
    await attempt('close the guardian control', partial.close);
  } else if (partial.reaperChannel !== null) {
    const reaperChannel = partial.reaperChannel;
    await attempt('close the reaper control channel', () => reaperChannel.close());
  }

  const clock = createMonotonicClock(guardianConstructionUnwindClockScope);
  const environment = buildContainmentEnvironment(clock, ports);
  let reaperCleanup: GuardianConstructionCleanupDisposition = { kind: 'settled' };
  const failedRoleSpawnCleanup =
    partial.failedRoleSpawn === null ? { kind: 'settled' as const } : holdFailedRoleSpawn(partial.failedRoleSpawn);
  if (partial.proxySpawn !== null) {
    const proxySpawn = partial.proxySpawn;
    proxyCleanup = await reapUnheldProcessGroup(
      {
        pid: proxySpawn.pid,
        incarnation: proxySpawn.incarnation,
        processGroupId: proxySpawn.pid,
      },
      clock,
      environment,
    );
    if (proxyCleanup.kind === 'holding') {
      const detail = guardianConstructionCleanupHoldDetail(proxyCleanup);
      stranded.push(`reap the proxy process group (${detail})`);
      backendLog.error(`guardian construction cleanup could not reap the proxy process group: ${detail}`);
    }
  }
  if (partial.reaperSpawn !== null) {
    const reaperSpawn = partial.reaperSpawn;
    reaperCleanup = await reapUnheldOrdinaryProcess(
      { pid: reaperSpawn.pid, incarnation: reaperSpawn.incarnation },
      ports,
    );
    if (reaperCleanup.kind === 'holding') {
      const detail = guardianConstructionCleanupHoldDetail(reaperCleanup);
      stranded.push(`reap the reaper process (${detail})`);
      backendLog.error(`guardian construction cleanup could not reap the reaper process: ${detail}`);
    }
  }

  if (stranded.length > 0) {
    backendLog.error(`guardian construction failed and could not clean up: ${stranded.join(', ')}`);
  }
  return combineGuardianConstructionCleanup([proxyCleanup, reaperCleanup, failedRoleSpawnCleanup]);
}

/**
 * Races a role's own readiness against its spawn's async failure, so a spawn error the OS reports after the
 * synchronous `spawn()` call already returned surfaces here as this attempt's own rejection rather than
 * waiting out the full readiness wait — or worse, escaping as an uncaught exception with no listener at all.
 * `readiness` is given a no-op catch: `Promise.race` never observes a losing promise's eventual settlement,
 * so if the spawn failure wins the race first, `readiness`'s own later rejection must not become an
 * unhandled one.
 */
function raceReadinessAgainstSpawnFailure<T>(readiness: Promise<T>, spawnFailed: Promise<never>): Promise<T> {
  readiness.catch(() => {});
  return Promise.race([readiness, spawnFailed]);
}

/**
 * Runs the guardian: consumes its capsule, spawns the reaper outside the future proxy group, pairs with it,
 * starts listening, spawns the proxy as a new process-group leader, and records the containment it watched
 * being created. Each step is awaited in this exact order because the next one depends on it: the reaper
 * must exist before it can be paired with, the guardian must be listening before the proxy can connect to
 * it, and the proxy's pid and incarnation must be known before there is anything to record.
 *
 * The guardian owns the two cuts this function can fail at — the reaper spawn/pairing and the proxy spawn —
 * and therefore owns unwinding them: a half-built set is worse than none, because the enforcers arm on their
 * own clocks and would eventually reap themselves while the coordinator still believes the set never
 * existed. `reaperSpawn`, `reaperChannel`, `close`, and `proxySpawn` are tracked outside the `try` so the
 * `catch` can unwind exactly what this attempt actually created, however far it got.
 */
export async function startProviderGuardianRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<GuardianRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'guardian', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(guardianRoleClockScope);
  const deadlineConfiguration = resolveProviderProxyDeadlineConfiguration(ports.runtime.env);
  // Guardian deadlines and enforcement must share one holder authority.
  const holderAuthority = createControlHolderAuthority({ wallClockNow: ports.runtime.time.now });
  const deadlines = buildDeadlines(clock, deadlineConfiguration, ports, holderAuthority);
  const containmentEnvironment = buildContainmentEnvironment(clock, ports);
  const timer = runtimeControlTimer(ports.runtime);
  const spawnPorts = buildSpawnPorts(ports);
  const roleEnv = {
    [BUILD_FLAVOR_ENV_KEY]: capsule.flavor,
    [CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV]: String(deadlineConfiguration.orphanTimeoutMs),
  };
  const exitProcess = ports.exitProcess ?? ((code: number): void => process.exit(code));
  const schedule = realRoleOutcomeScheduler(ports);
  const self = readSelfIdentity(ports);
  let reaperSpawn: SpawnedRoleProcess | null = null;
  let reaperChannel: ControlClient | null = null;
  let close: (() => Promise<void>) | null = null;
  let proxySpawn: SpawnedRoleProcess | null = null;
  let failedRoleSpawn: HeldRoleSpawn | null = null;

  try {
    const reaperDisposition = await requireSpawnedRole(
      spawnRoleProcess('reaper', reaperCapsulePathFrom(capsule, ports.baseDir), spawnPorts, {
        pluginRoot: ports.pluginRoot,
        detached: false,
        envAdditions: roleEnv,
      }),
    );
    if (reaperDisposition.kind === 'held') {
      failedRoleSpawn = reaperDisposition;
      throw reaperDisposition.error;
    }
    reaperSpawn = reaperDisposition;

    const reaperConnected = connectRoleControlWithRetry(capsule.reaperControlEndpoint, timer, {
      connectTimeoutMs: ROLE_CONNECT_TIMEOUT_MS,
      retryIntervalMs: ROLE_SPAWN_READY_RETRY_INTERVAL_MS,
      overallDeadlineMs: ROLE_SPAWN_READY_DEADLINE_MS,
      monotonicNow: () => ports.runtime.time.monotonicNow(),
      sleep: (ms) => ports.runtime.time.sleep(ms),
    });
    reaperChannel = await raceReadinessAgainstSpawnFailure(reaperConnected, reaperSpawn.spawnFailed);
    const pairingResult = requireRolePeerResult(
      'reaper.pair.v1',
      await reaperChannel.exchange(
        'reaper.pair.v1',
        controlPairParamsSchema.parse({ pairingSecret: capsule.guardianReaperAuthSecret }),
        PROXY_CONTROL_RPC_TIMEOUT_MS,
      ),
    );
    controlPairResultSchema.parse(pairingResult);

    const pairedReaperChannel = reaperChannel;
    // Forward-referenced by `close` below (assigned into `createGuardian`'s own `onOutcome` before the
    // guardian it closes exists), then assigned exactly once — `let` is load-bearing here, not a style choice.
    // eslint-disable-next-line prefer-const
    let guardianRef!: Guardian;
    close = async (): Promise<void> => {
      pairedReaperChannel.close();
      await guardianRef.close();
    };
    const { onOutcome, onProgressViolation, enforcementHoldStatus, abandonUnattributable } =
      buildEnforcementOutcomeHandlers({
        role: 'guardian',
        roleIdentity: self,
        deadlines,
        close,
        exitProcess,
        grantWasInstalled: () => holderAuthority.phase() === 'published',
        now: ports.runtime.time.now,
        retryUnattributable: () => guardianRef.enforcer()?.retryUnattributable() ?? null,
        schedule,
      });
    guardianRef = createGuardian({
      capsule,
      clock,
      deadlines,
      containmentEnvironment,
      scheduler: buildScheduler(ports.runtime),
      timer,
      mintReceipt: () => ports.runtime.ids.uuid(),
      reaperChannel: pairedReaperChannel,
      self,
      reaperSelf: { pid: reaperSpawn.pid, incarnation: reaperSpawn.incarnation },
      holderAuthority,
      observeHolder: buildHolderObserver(ports),
      enforcementHoldStatus,
      abandonUnattributable,
      onOutcome,
      onProgressViolation,
    });
    const guardian = guardianRef;

    await guardian.listen();
    ports.onGuardianListening?.();

    const proxyDisposition = await requireSpawnedRole(
      spawnRoleProcess('proxy', proxyCapsulePathFrom(capsule, ports.baseDir), spawnPorts, {
        pluginRoot: ports.pluginRoot,
        detached: true,
        envAdditions: roleEnv,
      }),
    );
    if (proxyDisposition.kind === 'held') {
      failedRoleSpawn = proxyDisposition;
      throw proxyDisposition.error;
    }
    proxySpawn = proxyDisposition;

    const containmentRecorded = guardian.recordContainment({
      pid: proxySpawn.pid,
      incarnation: proxySpawn.incarnation,
      processGroupId: proxySpawn.pid,
      containmentKind: DETACHED_CONTAINMENT_KIND,
    });
    await raceReadinessAgainstSpawnFailure(containmentRecorded, proxySpawn.spawnFailed);
    const enforcer = guardian.enforcer();
    if (enforcer === null) {
      throw new Error('Guardian containment recording completed without an armed enforcer.');
    }

    return {
      role: 'guardian',
      guardian,
      reaperSpawn,
      proxySpawn,
      close,
      giveUp: async (): Promise<LocalSignalTeardownDisposition> => {
        // Local signal authority must be minted only while handling that signal.
        return enforcer.giveUp(mintLocalSignalTeardownAuthorization());
      },
    };
  } catch (error: unknown) {
    const cleanup = await unwindGuardianConstruction(ports, {
      close,
      reaperChannel,
      reaperSpawn,
      proxySpawn,
      failedRoleSpawn,
    });
    if (cleanup.kind === 'holding') throw new GuardianConstructionCleanupHeldError(error, cleanup);
    throw markGuardianConstructionCleanupSettled(error);
  }
}

/** Runs the reaper: consumes its capsule and starts listening. It holds nothing to enforce until the
 *  guardian reports the containment it watched being created over `reaper.record-containment.v1`. */
export async function startProviderReaperRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<ReaperRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'reaper', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(reaperRoleClockScope);
  // Reaper deadlines and enforcement must share one holder authority.
  const holderAuthority = createControlHolderAuthority({ wallClockNow: ports.runtime.time.now });
  const deadlines = buildDeadlines(
    clock,
    resolveProviderProxyDeadlineConfiguration(ports.runtime.env),
    ports,
    holderAuthority,
  );
  const exitProcess = ports.exitProcess ?? ((code: number): void => process.exit(code));
  const self = readSelfIdentity(ports);
  // Forward-referenced by `close` below (assigned into `createReaper`'s own `onOutcome` before the reaper it
  // closes exists), then assigned exactly once — `let` is load-bearing here, not a style choice.
  // eslint-disable-next-line prefer-const
  let reaperRef!: Reaper;
  const close = (): Promise<void> => reaperRef.close();
  const { onOutcome, onProgressViolation, enforcementHoldStatus, abandonUnattributable } =
    buildEnforcementOutcomeHandlers({
      role: 'reaper',
      roleIdentity: self,
      deadlines,
      close,
      exitProcess,
      grantWasInstalled: () => holderAuthority.phase() === 'published',
      now: ports.runtime.time.now,
      retryUnattributable: () => reaperRef.enforcer()?.retryUnattributable() ?? null,
      schedule: realRoleOutcomeScheduler(ports),
    });

  reaperRef = createReaper({
    capsule,
    clock,
    deadlines,
    containmentEnvironment: buildContainmentEnvironment(clock, ports),
    scheduler: buildScheduler(ports.runtime),
    timer: runtimeControlTimer(ports.runtime),
    mintReceipt: () => ports.runtime.ids.uuid(),
    self,
    holderAuthority,
    observeHolder: buildHolderObserver(ports),
    enforcementHoldStatus,
    abandonUnattributable,
    onOutcome,
    onProgressViolation,
  });
  await reaperRef.listen();

  return {
    role: 'reaper',
    reaper: reaperRef,
    close,
    giveUp: async (): Promise<ReaperSignalTeardownDisposition> => {
      const armed = reaperRef.enforcer();
      if (armed === null) {
        await close()
          .catch((error: unknown) => backendLog.error('reaper: close on exit failed', error))
          .finally(() => exitProcess(0));
        return { kind: 'closed-without-containment' };
      }
      // Local signal authority must be minted only while handling that signal.
      return armed.giveUp(mintLocalSignalTeardownAuthorization());
    },
  };
}

/** `guardian.register-provider-root.v1`'s reply, kept strict because the paired guardian is still a wire peer. */
const registerProviderRootResultSchema = z
  .object({
    state: z.literal('staged-contained'),
    providerRoot: providerRootSchema,
    jointContainmentReceipt: jointContainmentReceiptSchema,
  })
  .strict();

/** What `createProxyGuardianContainment` needs to talk to the guardian on the kernel's behalf, with every
 *  dependency that would otherwise force a real provider spawn or a real spawned guardian process taken as a
 *  parameter. */
export type ProxyGuardianContainmentDeps = Readonly<{
  identity: ProxyIdentity;
  guardianChannel: Pick<ControlClient, 'exchange'>;
  stageProviderRoot(key: ProviderOperationKey, prepared: ProxyPreparedAppServerOperation): SemanticOperationStageHandle;
}>;

/**
 * Builds the containment closures a proxy uses to talk to its guardian on the kernel's behalf:
 * `stageProviderRoot` (called from `operation.prepare.v1`). Extracted out of `startProviderProxyRole` so it can
 * be exercised against a real `createGuardian` in a test without spawning a real provider — only the semantic
 * stage needs replacing for
 * that, everything else here is the real wiring `startProviderProxyRole` itself installs.
 *
 * Takes no ledger access of any kind: `stageProviderRoot`'s `reservation` parameter is exactly what
 * `ledger.prepare()` already returned to `proxy.ts`'s own caller, passed straight through rather than fetched
 * here a second time. A seam that could independently ask the ledger for "the" reservation is a seam that can
 * be asked before one exists — a seam with no such question to ask cannot make that mistake.
 *
 */
export function createProxyGuardianContainment(
  deps: ProxyGuardianContainmentDeps,
): ProxyOptions<symbol>['containment'] {
  return {
    stageProviderRoot: (key, reserved) => {
      const semanticStage = deps.stageProviderRoot(key, reserved.prepared);
      let guardianMayHoldMembership = false;
      let guardianReleased = false;
      let recognisedReceipt: JointContainmentReceipt | null = null;
      const result = semanticStage.result.then(async (staged) => {
        if (staged.state === 'permanent-refusal' || staged.state === 'capacity') return staged;
        const root = staged.providerRoot;
        const params = guardianRegisterProviderRootParamsSchema.parse({
          proxy: deps.identity,
          operation: {
            jobId: key.jobId,
            operationId: key.operationId,
            proxyInstanceId: deps.identity.proxyInstanceId,
            buildSetId: deps.identity.buildSetId,
          },
          reservation: reserved.reservation,
          providerPid: root.pid,
          providerIncarnation: root.incarnation,
        });
        guardianMayHoldMembership = true;
        const response = requireRolePeerResult(
          'guardian.register-provider-root.v1',
          await deps.guardianChannel.exchange(
            'guardian.register-provider-root.v1',
            params,
            PROXY_CONTROL_RPC_TIMEOUT_MS,
          ),
        );
        const parsed = registerProviderRootResultSchema.parse(response);
        recognisedReceipt = parsed.jointContainmentReceipt;
        return {
          state: 'staged' as const,
          providerRoot: parsed.providerRoot,
          receipt: parsed.jointContainmentReceipt,
        };
      });

      const handle: OperationStageHandle = Object.freeze({
        result,
        async confirmActivation(input: Parameters<OperationStageHandle['confirmActivation']>[0]) {
          const { jointContainmentReceipt, jointActivationReceipt } = input;
          if (recognisedReceipt === null || recognisedReceipt !== jointContainmentReceipt) {
            throw new Error(
              `Activation named a containment receipt this proxy never staged for ${key.jobId}/${key.operationId}.`,
            );
          }
          if (jointActivationReceipt.length === 0) {
            throw new Error('Activation presented an empty activation receipt.');
          }
        },
        async abortAndRelease() {
          const semanticRelease = semanticStage.abortAndRelease();
          try {
            await result;
          } catch {
            // Registration ambiguity still requires the idempotent guardian release below.
          }
          await semanticRelease;
          if (!guardianMayHoldMembership || guardianReleased) return;
          const params = guardianProxyOperationReleaseParamsSchema.parse({
            proxy: deps.identity,
            operation: {
              jobId: key.jobId,
              operationId: key.operationId,
              proxyInstanceId: deps.identity.proxyInstanceId,
              buildSetId: deps.identity.buildSetId,
            },
            reservation: reserved.reservation,
          });
          const response = requireRolePeerResult(
            'guardian.operation-release.v1',
            await deps.guardianChannel.exchange('guardian.operation-release.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS),
          );
          guardianProxyOperationReleaseResultSchema.parse(response);
          guardianReleased = true;
        },
      });
      return handle;
    },
  };
}

/**
 * This role main owns the process topology, endpoint and guardian-authentication surface, and the
 * containment closures that talk to the guardian on the kernel's behalf (`Proxy`'s own
 * `containment.stageProviderRoot`/`confirmActivation`).
 */
export async function startProviderProxyRole(
  capsulePath: string,
  ports: ProviderRoleMainPorts,
): Promise<ProxyRoleHandle> {
  const capsule = consumeProviderBootstrapCapsule(capsulePath, 'proxy', buildCapsuleEnv(ports));
  const clock = createMonotonicClock(proxyRoleClockScope);
  const self = readSelfIdentity(ports);
  const timer = runtimeControlTimer(ports.runtime);

  const identity: ProxyIdentity = {
    proxyInstanceId: capsule.proxyInstanceId,
    pid: self.pid,
    incarnation: self.incarnation,
    processGroupId: self.pid,
    guardianInstanceId: capsule.guardianInstanceId,
    reaperInstanceId: capsule.reaperInstanceId,
    generation: capsule.generation,
    flavor: capsule.flavor,
    buildSetId: capsule.buildSetId,
    hostFingerprint: capsule.hostFingerprint,
    canonicalEndpoint: capsule.canonicalEndpoint,
  };

  // The guardian must already be listening by the time this process exists — it spawns the proxy only after
  // its own `listen()` resolves — so this is an ordinary connect, retried only for the residual scheduling
  // window between the OS reporting this process spawned and its socket file becoming dialable.
  const guardianChannel = await connectRoleControlWithRetry(capsule.guardianControlEndpoint, timer, {
    connectTimeoutMs: ROLE_CONNECT_TIMEOUT_MS,
    retryIntervalMs: ROLE_SPAWN_READY_RETRY_INTERVAL_MS,
    overallDeadlineMs: ROLE_SPAWN_READY_DEADLINE_MS,
    monotonicNow: () => ports.runtime.time.monotonicNow(),
    sleep: (ms) => ports.runtime.time.sleep(ms),
  });
  const pairingResult = requireRolePeerResult(
    'guardian.pair.v1',
    await guardianChannel.exchange(
      'guardian.pair.v1',
      controlPairParamsSchema.parse({ pairingSecret: capsule.proxyGuardianAuthSecret }),
      PROXY_CONTROL_RPC_TIMEOUT_MS,
    ),
  );
  controlPairResultSchema.parse(pairingResult);

  const hostAuthority = createProxyAppServerHostAuthority(ports.runtime);
  const exitProcess = ports.exitProcess ?? ((code: number): void => process.exit(code));
  let closePromise: Promise<void> | null = null;
  let relinquishmentStarted = false;
  // Forward-referenced: `createSemanticOperationRuntime`'s host needs the `Proxy` this call is itself building
  // (to pump events and read ledger state), and `createProxy` needs that host before the `Proxy` it returns
  // can exist — the same shape `guardianRef`/`reaperRef` already use above for their own peer/self references.
  // eslint-disable-next-line prefer-const
  let proxyRef!: Proxy;
  const semantic = createSemanticOperationRuntime({
    runtime: ports.runtime,
    hostAuthority,
    getProxy: () => proxyRef,
    onRelinquish: (failure) => {
      if (relinquishmentStarted) return;
      relinquishmentStarted = true;
      queueMicrotask(() => {
        void closeRole().then(
          () => {
            backendLog.error('proxy: cancellation was unconfirmed; relinquishing provider set', failure);
            exitProcess(ROLE_ENFORCEMENT_FAILURE_EXIT_CODE);
          },
          (error: unknown) => {
            backendLog.error('proxy: set relinquishment after unconfirmed cancellation failed', error);
            exitProcess(ROLE_ENFORCEMENT_FAILURE_EXIT_CODE);
          },
        );
      });
    },
  });

  const proxy = createProxy({
    capsule,
    clock,
    identity,
    host: semantic.host,
    providerHosts: hostAuthority,
    timer,
    mintChallenge: () => ports.runtime.ids.uuid(),
    mintReceipt: () => ports.runtime.ids.uuid(),
    // The one place a reservation is created. `.parse()` is what mints the brand, so this expression — the
    // proxy's own authority to reserve — is the only expression in the tree that can produce one from raw
    // randomness. Everywhere else a reservation can only have been received.
    mintReservation: () => reservationSchema.parse(ports.runtime.ids.uuid()),
    wallClockNow: ports.runtime.time.now,
    containment: createProxyGuardianContainment({
      identity,
      guardianChannel,
      stageProviderRoot: semantic.stage,
    }),
  });
  proxyRef = proxy;
  await proxy.listen();

  const closeRole = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      let semanticFailure: unknown;
      let closeFailures: unknown[];
      try {
        await semantic.shutdown('signal_abort');
      } catch (error: unknown) {
        semanticFailure = error;
      } finally {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => guardianChannel.close()),
          proxy.close(),
        ]);
        closeFailures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      }
      if (semanticFailure !== undefined) {
        if (closeFailures.length > 0) {
          backendLog.error(
            'proxy: pairing/control closure also failed after semantic shutdown failure',
            new AggregateError(closeFailures),
          );
        }
        if (semanticFailure instanceof Error) throw semanticFailure;
        throw new Error('Proxy semantic shutdown failed.', { cause: semanticFailure });
      }
      if (closeFailures.length > 0) {
        throw new AggregateError(closeFailures, 'Proxy role pairing/control closure failed.');
      }
    })();
    return closePromise;
  };

  return {
    role: 'proxy',
    proxy,
    // Give every provider its own chance at a graceful stop, then always relinquish pairing and proxy
    // control. The joined promise makes a second signal observe the same drain and the same failure.
    close: closeRole,
  };
}

export type ProviderRoleMainOptions = Readonly<{ pluginRoot: string; runtime?: Runtime }>;

type RoleProbeSettlementDisposition = SettledSettlementDisposition | RoleProbeHeldSettlementDisposition;

interface RoleProbeHeldSettlementDisposition extends HeldSettlementDisposition<
  'process-incarnation-probes-unsettled',
  'process-incarnation-probe-settlement',
  never,
  readonly ProcessIncarnationProbeHold[],
  RoleProbeSettlementDisposition
> {
  retry(): Promise<RoleProbeSettlementDisposition>;
}

const roleProbeSettlementGate = new SettlementGate<
  never,
  'process-incarnation-probes-unsettled',
  'process-incarnation-probe-settlement',
  never,
  readonly ProcessIncarnationProbeHold[],
  never,
  RoleProbeSettlementDisposition
>();

async function settleRoleShutdownProbes(): Promise<RoleProbeSettlementDisposition> {
  const disposition = await terminateProcessIncarnationProbes();
  if (disposition.disposition === 'settled') return roleProbeSettlementGate.settled();
  return roleProbeSettlementGate.held({
    reason: 'process-incarnation-probes-unsettled',
    exit: 'process-incarnation-probe-settlement',
    retryAfter: disposition.untilSettled,
    deferredFailures: [],
    retainedAuthority: disposition.unsettled,
    retry: settleRoleShutdownProbes,
  });
}

function createRoleShutdownProbeGate(
  role: 'guardian' | 'reaper' | 'proxy',
  exitProcess: (code: number) => void,
): Readonly<{ requestCleanup(): void; requestExit(code: number): void; dispose(): void }> {
  let requestedExitCode: number | null = null;
  let cleanupInFlight = false;
  let exited = false;
  let disposed = false;

  const cleanupFailed = (error: unknown, cleanupSubjects: readonly ProcessIncarnationProbeSubject[]): void => {
    const subjects = cleanupSubjects
      .map((subject) => ('key' in subject ? `key=${subject.key}` : `pid=${subject.pid}`))
      .join('; ');
    if (disposed) return;
    cleanupInFlight = false;
    backendLog.error(
      `${role}: process-incarnation probe cleanup failed; shutdown remains held; registered subjects: ${subjects || 'none'}`,
      error,
    );
  };

  const acceptDisposition = (disposition: RoleProbeSettlementDisposition): void => {
    if (disposed) return;
    if (disposition.disposition === 'held') {
      const holds = disposition.retainedAuthority
        .map((hold) =>
          'key' in hold
            ? `key=${hold.key} reason=${hold.reason} exit=${hold.exit}`
            : `pid=${hold.pid ?? 'unavailable'} reason=${hold.reason} exit=${hold.exit}`,
        )
        .join('; ');
      backendLog.error(`${role}: shutdown remains held by unsettled process-incarnation probes: ${holds}`);
      void disposition.retryAfter.then(
        () => {
          const cleanupSubjects = snapshotProcessIncarnationProbeSubjects();
          void disposition.retry().then(acceptDisposition, (error: unknown) => cleanupFailed(error, cleanupSubjects));
        },
        (error: unknown) => cleanupFailed(error, snapshotProcessIncarnationProbeSubjects()),
      );
      return;
    }
    cleanupInFlight = false;
    if (requestedExitCode !== null) {
      exited = true;
      exitProcess(requestedExitCode);
    }
  };

  const requestCleanup = (): void => {
    if (cleanupInFlight || exited || disposed) return;
    cleanupInFlight = true;
    const cleanupSubjects = snapshotProcessIncarnationProbeSubjects();
    void settleRoleShutdownProbes().then(acceptDisposition, (error: unknown) => cleanupFailed(error, cleanupSubjects));
  };

  return {
    requestCleanup,
    requestExit: (code): void => {
      requestedExitCode ??= code;
      requestCleanup();
    },
    dispose: (): void => {
      disposed = true;
      requestedExitCode = null;
    },
  };
}

let activeRoleShutdownDispose: (() => void) | null = null;

/**
 * The `bootstrap.ts` dispatch target: composes the real runtime and runs whichever role `argv` named,
 * staying up for the lifetime of the process via its own open control socket — the same pattern the ordinary
 * coordinator's own `main()` uses. A `'none'` mode is a defensive no-op; `bootstrap.ts` never reaches this
 * function without a role already confirmed.
 */
export async function runProviderRoleMain(mode: ProviderRoleArgv, options: ProviderRoleMainOptions): Promise<number> {
  if (mode.role === 'none') return 0;

  // Stream error guards must be installed before logging; only EPIPE from a closed output pipe may be ignored.
  const guardParentPipe = (error: Error): void => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') return;
    throw error;
  };
  process.stdout.on('error', guardParentPipe);
  process.stderr.on('error', guardParentPipe);

  const runtime = options.runtime ?? createRealRuntime(resolveBuildFlavor(process.env));
  activeRoleShutdownDispose?.();
  let removeRoleSignalHandlers = (): void => undefined;
  let disposeRoleLifecycle = (): void => undefined;
  let processExitRequested = false;
  const probeGate = createRoleShutdownProbeGate(mode.role, (code) => {
    if (processExitRequested) return;
    processExitRequested = true;
    disposeRoleLifecycle();
    process.exit(code);
  });
  disposeRoleLifecycle = () => {
    probeGate.dispose();
    removeRoleSignalHandlers();
    if (activeRoleShutdownDispose === disposeRoleLifecycle) activeRoleShutdownDispose = null;
  };
  activeRoleShutdownDispose = disposeRoleLifecycle;
  const ports: ProviderRoleMainPorts = {
    runtime,
    pluginRoot: options.pluginRoot,
    exitProcess: probeGate.requestExit,
  };

  let handle: ProviderRoleHandle;
  if (mode.role === 'guardian') {
    try {
      handle = await startProviderGuardianRole(mode.capsulePath, ports);
    } catch (error: unknown) {
      let constructionExitCode = GUARDIAN_CONSTRUCTION_CONTAINMENT_SETTLED_EXIT_CODE;
      if (error instanceof GuardianConstructionCleanupHeldError) {
        backendLog.error('guardian: construction failed and spawned process cleanup remains held', error);
        let disposition: GuardianConstructionCleanupDisposition = error.hold;
        let operatorExitAccepted = false;
        let releaseOperatorSignal!: () => void;
        const operatorSignal = new Promise<void>((resolve) => {
          releaseOperatorSignal = resolve;
        });
        const abandonConstruction = (): void => {
          if (operatorExitAccepted) return;
          if (disposition.kind !== 'holding' || !acceptGuardianConstructionOperatorExit(disposition)) return;
          operatorExitAccepted = true;
          releaseOperatorSignal();
        };
        process.on('SIGTERM', abandonConstruction);
        process.on('SIGINT', abandonConstruction);
        try {
          while (disposition.kind === 'holding' && !operatorExitAccepted) {
            await Promise.race([runtime.time.sleep(ROLE_UNATTRIBUTABLE_REAP_BASE_DELAY_MS), operatorSignal]);
            if (operatorExitAccepted) break;
            const heldBeforeRetry: Extract<GuardianConstructionCleanupDisposition, { kind: 'holding' }> = disposition;
            try {
              disposition = await heldBeforeRetry.retry();
              if (disposition.kind === 'holding') {
                backendLog.error(
                  `guardian: construction cleanup retry remains held: ${guardianConstructionCleanupHoldDetail(disposition)}`,
                );
              }
            } catch (retryError: unknown) {
              backendLog.error(
                `guardian: construction cleanup retry failed; shutdown remains held: ${guardianConstructionCleanupHoldDetail(heldBeforeRetry)}`,
                retryError,
              );
            }
          }
        } finally {
          process.removeListener('SIGTERM', abandonConstruction);
          process.removeListener('SIGINT', abandonConstruction);
        }
        if (operatorExitAccepted) {
          constructionExitCode = 0;
          probeGate.requestExit(0);
        }
      } else {
        if (!isGuardianConstructionCleanupSettled(error)) {
          disposeRoleLifecycle();
          throw error;
        }
        backendLog.error('guardian: construction failed after spawned process cleanup settled', error);
      }
      if (constructionExitCode !== 0) disposeRoleLifecycle();
      return constructionExitCode;
    }
  } else if (mode.role === 'reaper') {
    try {
      handle = await startProviderReaperRole(mode.capsulePath, ports);
    } catch (error: unknown) {
      disposeRoleLifecycle();
      throw error;
    }
  } else {
    try {
      handle = await startProviderProxyRole(mode.capsulePath, ports);
    } catch (error: unknown) {
      disposeRoleLifecycle();
      throw error;
    }
  }

  let proxyShutdownStarted = false;

  const shutdown = (): void => {
    probeGate.requestCleanup();
    if (handle.role === 'proxy') {
      if (proxyShutdownStarted) return;
      proxyShutdownStarted = true;
      void handle.close().then(
        () => probeGate.requestExit(0),
        (error: unknown) => {
          backendLog.error('proxy: close on shutdown failed', error);
          probeGate.requestExit(ROLE_ENFORCEMENT_FAILURE_EXIT_CODE);
        },
      );
      return;
    }
    const role = handle.role;
    void handle
      .giveUp()
      .catch((error: unknown) =>
        backendLog.error(
          `${role}: give-up on shutdown failed; containment remains held; SIGTERM or SIGINT retries teardown`,
          error,
        ),
      );
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  removeRoleSignalHandlers = () => {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
  };

  return 0;
}
