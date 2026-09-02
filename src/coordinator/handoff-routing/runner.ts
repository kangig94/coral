import { processIncarnationSchema } from '../../infra/node-process.js';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { backendLog } from '../../infra/backend-log.js';
import { probeCoordinator, type CoordinatorDiscoveryRecord } from '../../infra/backend-discovery.js';
import { resolveBuildFlavor } from '../../infra/build-flavor.js';
import {
  readBuildFlavor,
  resolveStrictBundleIdentity,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../../infra/bundle-manifest.js';
import {
  createForeignTargetValidator,
  inspectValidatedHandoffTarget,
  withValidatedHandoffTarget,
  type ForeignTargetValidator,
  type ForeignTargetValidationResult,
  type ValidatedHandoffTarget,
} from '../../infra/handoff-target.js';
import { handoffRoutingStatusPathForRunDir } from '../../infra/path/index.js';
import { assertNever } from '../../infra/error-format.js';
import type { TimePort } from '../../infra/port-types.js';
import { pluginRootNamespace } from '../../infra/plugin-identity.js';
import type { RecordedProcessIdentity } from '../../infra/process-containment.js';
import type { Runtime } from '../../runtime/ports.js';
import { createRealRuntime } from '../../runtime/real.js';
import { handoffRoutingStatusGeneration } from '../../store/handoff-routing-status-store/index.js';
import { createIpcClient } from '../../transport/ipc/client.js';
import {
  resolveStartupAttemptLineage,
  startupAttemptIdentityMatches,
  type StartupAttemptIdentity,
  type StartupAttemptLineage,
} from '../../infra/startup-attempt-lineage.js';
import {
  HANDOFF_ROUTING_BASIS_OBLIGATIONS,
  buildSummarySchema,
  incumbentIdentitySummarySchema,
  routeLiveIncumbent,
  type BuildSummary,
  type HandoffRoutingBasis,
  type HandoffRoutingResult,
  type IncumbentIdentitySummary,
  type RoutingBasisObligation,
  type UnresolvedIncumbentCause,
} from './policy.js';
import { classifyHandoffRoutingStatusOperatorInvocation } from './repair-operation.js';
import type {
  DirectTerminalDisposition,
  DurableHandoffRoutingBasis,
  HandoffRoutingTransition,
  PublicationOutcome,
  SelectedHandoffDisposition,
} from './status.js';

// The pre-flight's own probe budget. Not `HEALTH_TIMEOUT_MS` from `transport/http/sse.ts`: the coordinator
// topology invariant forbids a coordinator module depending on the HTTP transport, and this bound answers a
// different question — how long a CLI may wait before dispatching without an incumbent.
const INCUMBENT_HEALTH_PROBE_TIMEOUT_MS = 3_000;
const STDOUT_HANDOFF_DRAIN_TIMEOUT_MS = 3_000;
const BACKEND_STARTUP_LIVENESS_CONFIRMATION_MS = 100;
const CLI_HANDOFF_GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';

const handoffSuccessBrand: unique symbol = Symbol('HandoffSuccess');
const cliHandoffGuardSchema = z.enum(['0', '1']).optional();
const incumbentIdentityShape = incumbentIdentitySummarySchema.unwrap().unwrap().shape;

const handoffOperationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cli-invocation'),
      argv: z.array(z.string()).min(2),
    })
    .strict(),
  z
    .object({
      kind: z.literal('wait-jobs'),
      jobId: z.string().min(1),
      // Opaque here on purpose: the caller already holds the serialized cursor, and decoding it would make
      // this coordinator module depend on the jobs domain's wait vocabulary just to re-encode the same string.
      serializedCursor: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('backend-startup') }).strict(),
]);

export const liveIncumbentHealthSchema = z
  .object({
    status: z.enum(['starting', 'ok', 'draining']),
    version: incumbentIdentityShape.version,
    bundleHash: incumbentIdentityShape.bundleHash,
    flavor: incumbentIdentityShape.flavor,
    namespace: z.string().min(1),
    instanceId: incumbentIdentityShape.instanceId,
    pid: z.number().int().positive(),
    incarnation: processIncarnationSchema.optional(),
    env: z.record(z.string()).optional(),
    manifest: strictBundleManifestSchema.optional(),
    bundleDir: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => isAbsolute(value) && resolve(value) === value, 'bundleDir must be canonical')
      .optional(),
  })
  .passthrough()
  .superRefine((health, context) => {
    if ((health.manifest === undefined) !== (health.bundleDir === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'manifest and bundleDir must appear together' });
      return;
    }
    if (
      health.manifest !== undefined &&
      (health.manifest.version !== health.version ||
        health.manifest.bundleHash !== health.bundleHash ||
        health.manifest.flavor !== health.flavor)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'manifest does not match health identity' });
    }
  });

type LiveIncumbentHealth = z.infer<typeof liveIncumbentHealthSchema>;

type LiveIncumbentReading =
  | Readonly<{ kind: 'observed'; health: LiveIncumbentHealth }>
  | Readonly<{ kind: 'observed-unusable'; cause: 'draining' | 'identity-mismatch' }>
  | Readonly<{ kind: 'not-observed'; reason: 'absent' }>
  | Readonly<{ kind: 'not-observed'; reason: 'unresolved'; cause: UnresolvedIncumbentCause }>;

export type HandoffOperation =
  | Readonly<{ kind: 'cli-invocation'; argv: readonly string[] }>
  | Readonly<{ kind: 'wait-jobs'; jobId: string; serializedCursor: string }>
  | Readonly<{ kind: 'backend-startup' }>;

export type HandoffSuccess = Readonly<{
  kind: 'handoff-success';
  version: string;
  [handoffSuccessBrand]: true;
}>;

export type HandoffOutcome =
  | HandoffSuccess
  | Readonly<{ kind: 'handoff-exit'; exitCode: number }>
  | Readonly<{ kind: 'handoff-signal'; signal: NodeJS.Signals }>;

export type HandoffContinuationReason =
  | Readonly<{ kind: 'routing'; basis: HandoffRoutingBasis }>
  | Readonly<{ kind: 'handoff-not-applicable'; reason: 'display-only' }>
  | Readonly<{ kind: 'handoff-abandoned'; reason: 'stdout-drain-incomplete' }>;

// A routing continuation must resolve its obligation through its basis table.
export const HANDOFF_CONTINUATION_REASON_OBLIGATIONS = {
  'handoff-not-applicable': {
    requiredDurability: 'ephemeral-allowed',
    requiredRetention: 'until-superseded',
    severity: 'info',
    exitContribution: 0,
  },
  'handoff-abandoned': {
    requiredDurability: 'durable-status-required',
    requiredRetention: 'bounded-history',
    severity: 'warning',
    exitContribution: 75,
  },
} as const satisfies Readonly<Record<Exclude<HandoffContinuationReason['kind'], 'routing'>, RoutingBasisObligation>>;

export const ABSENT_HANDOFF_RESULT_OBLIGATION = {
  requiredDurability: 'ephemeral-allowed',
  requiredRetention: 'until-superseded',
  severity: 'info',
  exitContribution: 0,
} as const satisfies RoutingBasisObligation;

export type HandoffContinuationResult =
  | Readonly<{ kind: 'run-current'; reason: HandoffContinuationReason }>
  | Readonly<{ kind: 'delegated'; version: string; outcome: HandoffOutcome }>;

export type HandoffRecordingRefusal =
  | Readonly<{
      reason: 'owner-identity-unavailable';
      remediation: 'retry-when-process-identity-is-readable';
      attemptedPhase: 'selection';
    }>
  | Readonly<{
      reason: 'invalid-target-authority';
      remediation: 'retry-with-live-target-authority';
      attemptedPhase: 'selection';
    }>
  | Readonly<{
      reason: 'selection-publication-outcome-unknown';
      remediation: 'inspect-routing-status-before-repair';
      attemptedPhase: 'terminal';
    }>;

type PublicationFailure = Exclude<PublicationOutcome, { kind: 'committed' }>;

type HandoffPublicationFailureIncident = PublicationFailure &
  (
    | Readonly<{ phase: 'selection'; invocationId: string }>
    | Readonly<{
        phase: 'terminal';
        invocationId: string;
        terminalDisposition: DirectTerminalDisposition;
      }>
  );

type HandoffRefusalIncident =
  | Readonly<{
      phase: 'selection';
      invocationId: string;
      kind: 'refused';
      refusal: Extract<HandoffRecordingRefusal, { attemptedPhase: 'selection' }>;
    }>
  | Readonly<{
      phase: 'terminal';
      invocationId: string;
      terminalDisposition: DirectTerminalDisposition;
      kind: 'refused';
      refusal: Extract<HandoffRecordingRefusal, { attemptedPhase: 'terminal' }>;
    }>;

export type HandoffPublicationIncident = HandoffPublicationFailureIncident | HandoffRefusalIncident;

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type HandoffRunResult =
  | Readonly<{
      kind: 'recorded';
      continuation: HandoffContinuationResult;
      publicationIncidents: readonly [];
    }>
  | Readonly<{
      kind: 'recording-not-applicable';
      continuationWithoutRecording: HandoffContinuationResult;
    }>
  | Readonly<{
      kind: 'recording-incidents';
      observedWork: HandoffContinuationResult;
      publicationIncidents: NonEmptyReadonlyArray<HandoffPublicationIncident>;
    }>;

export function consumeHandoffRunResult(
  result: HandoffRunResult,
  handleRecordingIncidents: (incidents: NonEmptyReadonlyArray<HandoffPublicationIncident>) => void,
): HandoffContinuationResult {
  switch (result.kind) {
    case 'recorded':
      return result.continuation;
    case 'recording-not-applicable':
      return result.continuationWithoutRecording;
    case 'recording-incidents': {
      handleRecordingIncidents(result.publicationIncidents);
      return result.observedWork;
    }
    default:
      return assertNever(result);
  }
}

export class HandoffRunError extends Error {
  readonly originalError: unknown;
  readonly incidents: NonEmptyReadonlyArray<HandoffPublicationIncident>;

  constructor(originalError: unknown, incidents: NonEmptyReadonlyArray<HandoffPublicationIncident>) {
    super('Handoff execution failed while routing-status publication was incomplete.');
    this.name = 'HandoffRunError';
    this.originalError = originalError;
    this.incidents = incidents;
  }
}

export type LiveHandoffContinuationResult = Extract<HandoffContinuationResult, { kind: 'run-current' }>;

export type LiveHandoffResult = Readonly<{
  continuation: LiveHandoffContinuationResult;
  publicationIncidents: readonly HandoffPublicationIncident[];
}>;

export function liveHandoffResultObligation(result: LiveHandoffResult | null): RoutingBasisObligation {
  if (result === null) return ABSENT_HANDOFF_RESULT_OBLIGATION;
  if (result.continuation.reason.kind === 'routing') {
    return HANDOFF_ROUTING_BASIS_OBLIGATIONS[result.continuation.reason.basis.kind];
  }
  return HANDOFF_CONTINUATION_REASON_OBLIGATIONS[result.continuation.reason.kind];
}

export type RunHandoffOptions = Readonly<{
  pluginRoot?: string;
  time?: TimePort;
  signal?: AbortSignal;
  activeSelectionTarget?: ValidatedHandoffTarget;
  onSelectionPublicationIncident?: (incident: HandoffPublicationIncident) => void;
}>;

type ChildOutcome = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type ObservedChild = Readonly<{
  spawned: Promise<void>;
  outcome: Promise<ChildOutcome>;
}>;

type BackendStartupObservation = Readonly<{ kind: 'ready' }> | Readonly<{ kind: 'terminal'; outcome: ChildOutcome }>;

type BackendStartupHoldReason =
  | Readonly<{
      kind: 'lineage-unproven';
      lineage: Exclude<StartupAttemptLineage, { kind: 'proven-current-attempt' }>;
    }>
  | Readonly<{ kind: 'not-serving'; status: Exclude<LiveIncumbentHealth['status'], 'ok'> }>;

type BackendStartupReadiness =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{
      kind: 'hold';
      until: 'serving-lineage-confirmed-health-or-child-terminal';
      reason: BackendStartupHoldReason;
    }>;

type RoutingResolution = Readonly<{
  routing: HandoffRoutingResult;
  runtime: Runtime;
  time: TimePort;
}>;

const foreignTargetValidator: ForeignTargetValidator = createForeignTargetValidator();

export function validateForeignHandoffTarget(
  bundleDir: string,
  expectedManifest: StrictBundleManifest,
): ForeignTargetValidationResult {
  return foreignTargetValidator(bundleDir, expectedManifest);
}

/**
 * Raised when the delegation marker holds a value Coral never writes. Owned here rather than imported from
 * `cli/errors.ts`: the guard is the runner's, and reaching into the CLI for its presentation type would close a
 * `cli -> coordinator -> cli` cycle. `buildErrorEnvelope` maps it to invalid usage on the CLI side.
 */
export class HandoffGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffGuardError';
  }
}

function readCliHandoffGuard(): '0' | '1' | undefined {
  const raw = process.env[CLI_HANDOFF_GUARD_ENV];
  const parsed = cliHandoffGuardSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }

  throw new HandoffGuardError(
    `${CLI_HANDOFF_GUARD_ENV} must be "0", "1", or unset (got ${JSON.stringify(raw)}). ` +
      `Coral sets it itself when it delegates to a newer build; unset it or set it to 0.`,
  );
}

function isDisplayOnlyInvocation(operation: HandoffOperation): boolean {
  return (
    operation.kind === 'cli-invocation' &&
    operation.argv.slice(2).some((argument) => argument === '--help' || argument === '-h' || argument === '--version')
  );
}

function discoveryMatchesHealth(
  discovery: CoordinatorDiscoveryRecord,
  canonicalSocketPath: string,
  health: LiveIncumbentHealth,
): boolean {
  return (
    discovery.socketPath === canonicalSocketPath &&
    discovery.pid === health.pid &&
    discovery.bundleHash === health.bundleHash &&
    discovery.flavor === health.flavor &&
    discovery.namespace === health.namespace &&
    (discovery.version === undefined || discovery.version === health.version) &&
    (discovery.instanceId === undefined || discovery.instanceId === health.instanceId) &&
    (discovery.incarnation === undefined || discovery.incarnation === health.incarnation)
  );
}

async function readAuthenticatedHealth(
  discovery: CoordinatorDiscoveryRecord,
  time: TimePort,
): Promise<Extract<LiveIncumbentReading, { kind: 'observed' | 'not-observed' }>> {
  try {
    const value = await createIpcClient(discovery.socketPath, time, {
      kind: 'boot',
      token: discovery.bootToken,
    }).health<unknown>({ timeoutMs: INCUMBENT_HEALTH_PROBE_TIMEOUT_MS });
    const parsed = liveIncumbentHealthSchema.safeParse(value);
    // Failing to obtain a valid authenticated reply is not evidence that no incumbent exists.
    return parsed.success
      ? { kind: 'observed', health: parsed.data }
      : { kind: 'not-observed', reason: 'unresolved', cause: 'health-shape-rejected' };
  } catch {
    return { kind: 'not-observed', reason: 'unresolved', cause: 'health-request-failed' };
  }
}

function summarizeIncumbentIdentity(health: LiveIncumbentHealth): IncumbentIdentitySummary {
  return incumbentIdentitySummarySchema.parse({
    version: health.version,
    bundleHash: health.bundleHash,
    flavor: health.flavor,
    instanceId: health.instanceId,
  });
}

export function routeAuthenticatedHealth(health: LiveIncumbentHealth): HandoffRoutingResult {
  const invokingIdentity = resolveStrictBundleIdentity();
  if (!invokingIdentity.ok) {
    return {
      kind: 'continue-current',
      basis: { kind: 'invoking-identity-unavailable', failure: invokingIdentity.reason },
    };
  }
  if (health.manifest === undefined || health.bundleDir === undefined) {
    return {
      kind: 'continue-current',
      basis: { kind: 'incumbent-identity-unavailable', incumbent: summarizeIncumbentIdentity(health) },
    };
  }
  return routeLiveIncumbent({
    invokingManifest: invokingIdentity.manifest,
    incumbent: Object.freeze({ bundleDir: health.bundleDir, expectedManifest: health.manifest }),
    validateForeignTarget: foreignTargetValidator,
  });
}

async function readLiveCoordinatorHealth(
  runtime: Pick<Runtime, 'env' | 'paths' | 'storage'>,
  time: TimePort,
): Promise<LiveIncumbentReading> {
  const probe = probeCoordinator({ storage: runtime.storage, env: runtime.env, paths: runtime.paths });
  // Every probe disposition must explicitly decide whether authenticated health can be requested.
  let discovery: CoordinatorDiscoveryRecord;
  switch (probe.kind) {
    case 'absent':
      return { kind: 'not-observed', reason: 'absent' };
    case 'unobservable':
      if (probe.reason === 'unreadable-record') {
        return { kind: 'not-observed', reason: 'unresolved', cause: 'unreadable-record' };
      }
      // An unobservable pid still has a record, and authenticated health is a stronger statement about whether
      // an incumbent is serving than a pid probe ever was — so ask it rather than concluding nobody is there.
      discovery = probe.record;
      break;
    case 'live':
      discovery = probe.record;
      break;
  }

  const reading = await readAuthenticatedHealth(discovery, time);
  if (reading.kind === 'not-observed') {
    backendLog.warn(
      `Authenticated health from ${discovery.socketPath} did not resolve; treating the incumbent as unobserved, not absent.`,
    );
    return reading;
  }
  if (reading.health.status === 'draining') {
    // A positive observation, not an absence: something answered, decoded, and named its own shutdown.
    backendLog.warn(`Live incumbent at ${discovery.socketPath} reported status draining; treating it as unusable.`);
    return { kind: 'observed-unusable', cause: 'draining' };
  }
  if (!discoveryMatchesHealth(discovery, runtime.paths.coral.coordinator.socketPath, reading.health)) {
    // Also a positive observation: something answered and decoded, naming an identity the discovery record
    // did not.
    backendLog.warn(
      `Authenticated health from ${discovery.socketPath} named a different coordinator identity than the discovery record; treating it as unusable.`,
    );
    return { kind: 'observed-unusable', cause: 'identity-mismatch' };
  }
  return reading;
}

async function resolveHandoffRouting(pluginRoot?: string, timePort?: TimePort): Promise<RoutingResolution> {
  const flavor = pluginRoot === undefined ? resolveBuildFlavor(process.env) : readBuildFlavor(pluginRoot);
  const runtime = createRealRuntime(flavor);
  const time = timePort ?? runtime.time;
  const reading = await readLiveCoordinatorHealth(runtime, time);
  return {
    routing:
      reading.kind === 'observed'
        ? routeAuthenticatedHealth(reading.health)
        : { kind: 'continue-current', basis: routingBasisForReading(reading) },
    runtime,
    time,
  };
}

function routingBasisForReading(reading: Exclude<LiveIncumbentReading, { kind: 'observed' }>): HandoffRoutingBasis {
  switch (reading.kind) {
    case 'observed-unusable':
      return { kind: 'incumbent-unusable', cause: reading.cause };
    case 'not-observed':
      switch (reading.reason) {
        case 'absent':
          return { kind: 'incumbent-absent' };
        case 'unresolved':
          return { kind: 'incumbent-unresolved', cause: reading.cause };
        default:
          return assertNever(reading);
      }
    default:
      return assertNever(reading);
  }
}

export async function resolveHandoffRoutingForOperation(
  operation: HandoffOperation,
  options: RunHandoffOptions,
): Promise<RoutingResolution> {
  if (options.activeSelectionTarget !== undefined) {
    const flavor =
      options.pluginRoot === undefined ? resolveBuildFlavor(process.env) : readBuildFlavor(options.pluginRoot);
    const runtime = createRealRuntime(flavor);
    return {
      routing: { kind: 'handoff', target: options.activeSelectionTarget, source: 'active-selection' },
      runtime,
      time: options.time ?? runtime.time,
    };
  }

  if (operation.kind === 'backend-startup') {
    throw new Error('Backend startup handoff requires a validated active-store target.');
  }

  return resolveHandoffRouting(options.pluginRoot, options.time);
}

function observeChild(child: ChildProcess): ObservedChild {
  const spawnedPromise = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const outcomePromise = new Promise<ChildOutcome>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  void outcomePromise.catch(() => undefined);

  return { spawned: spawnedPromise, outcome: outcomePromise };
}

function handoffOutcome(version: string, outcome: ChildOutcome): HandoffOutcome {
  if (outcome.signal !== null) {
    return Object.freeze({ kind: 'handoff-signal', signal: outcome.signal });
  }
  if (outcome.code !== 0) {
    return Object.freeze({ kind: 'handoff-exit', exitCode: outcome.code ?? 1 });
  }
  return Object.freeze({
    kind: 'handoff-success',
    version,
    [handoffSuccessBrand]: true as const,
  });
}

function endedChildOutcome(outcome: ChildOutcome): Exclude<HandoffOutcome, HandoffSuccess> {
  if (outcome.signal !== null) {
    return Object.freeze({ kind: 'handoff-signal', signal: outcome.signal });
  }
  return Object.freeze({ kind: 'handoff-exit', exitCode: outcome.code === 0 ? 1 : (outcome.code ?? 1) });
}

function startupAttemptLineage(
  health: LiveIncumbentHealth,
  desiredIdentity: StartupAttemptIdentity,
  expectedAttemptId: string | undefined,
): StartupAttemptLineage {
  return resolveStartupAttemptLineage({
    observedAttemptId: health.env?.CORAL_STARTUP_ATTEMPT_ID,
    expectedAttemptId,
    observedIdentity: health,
    desiredIdentity,
  });
}

/**
 * Readiness needs two proofs and neither substitutes for the other: lineage proves the answering coordinator
 * belongs to this attempt, and `ok` proves it finished starting. A selected backend that has bound its socket
 * and published its discovery record still answers `starting` while it can refuse, so releasing the direct
 * child on lineage alone strands every refusal raised after that point.
 */
function liveBackendStartupReadiness(
  reading: LiveIncumbentReading,
  desiredIdentity: StartupAttemptIdentity,
  expectedAttemptId: string | undefined,
): BackendStartupReadiness | null {
  if (reading.kind !== 'observed') {
    return null;
  }
  const until = 'serving-lineage-confirmed-health-or-child-terminal';
  const lineage = startupAttemptLineage(reading.health, desiredIdentity, expectedAttemptId);
  if (lineage.kind !== 'proven-current-attempt') {
    return { kind: 'hold', until, reason: { kind: 'lineage-unproven', lineage } };
  }
  const { status } = reading.health;
  return status === 'ok' ? { kind: 'ready' } : { kind: 'hold', until, reason: { kind: 'not-serving', status } };
}

/**
 * Terminality retires lineage's veto over a bare identity match; it does not retire lineage as a proof. The
 * inherited attempt id is the only one of the two that survives further delegation — a transitively delegated
 * coordinator carries this attempt's id while its build identity is a third build's — so accepting the
 * identity match alone records a startup that succeeded as a delegated exit. Terminality retires neither
 * half of the serving proof: a coordinator still starting has not answered whether it will serve at all.
 */
function terminalBackendStartupReadiness(
  reading: LiveIncumbentReading,
  desiredIdentity: StartupAttemptIdentity,
  expectedAttemptId: string | undefined,
): Readonly<{ kind: 'ready' }> | null {
  if (reading.kind !== 'observed' || reading.health.status !== 'ok') {
    return null;
  }
  const lineage = startupAttemptLineage(reading.health, desiredIdentity, expectedAttemptId);
  return lineage.kind === 'proven-current-attempt' || startupAttemptIdentityMatches(reading.health, desiredIdentity)
    ? { kind: 'ready' }
    : null;
}

async function waitForBackendStartupObservation(
  observation: ObservedChild,
  runtime: Runtime,
  time: TimePort,
  desiredIdentity: StartupAttemptIdentity,
  expectedAttemptId: string | undefined,
): Promise<BackendStartupObservation> {
  const terminal = observation.outcome.then((outcome) => ({ kind: 'terminal', outcome }) as const);

  while (true) {
    const reading = readLiveCoordinatorHealth(runtime, time);
    const readiness = reading.then((health) => liveBackendStartupReadiness(health, desiredIdentity, expectedAttemptId));
    const observed = await Promise.race([terminal, readiness]);
    if (observed !== null) {
      if (observed.kind === 'ready') {
        return observed;
      }
      if (observed.kind === 'terminal') {
        return terminalBackendStartupReadiness(await reading, desiredIdentity, expectedAttemptId) ?? observed;
      }
    }

    const terminalDuringPoll = await Promise.race([
      terminal,
      time.sleep(BACKEND_STARTUP_LIVENESS_CONFIRMATION_MS).then(() => null),
    ]);
    if (terminalDuringPoll !== null) {
      const finalHealth = await readLiveCoordinatorHealth(runtime, time);
      return terminalBackendStartupReadiness(finalHealth, desiredIdentity, expectedAttemptId) ?? terminalDuringPoll;
    }
  }
}

function delegatedArguments(operation: HandoffOperation): readonly string[] {
  switch (operation.kind) {
    case 'cli-invocation':
      return operation.argv.slice(2);
    case 'wait-jobs':
      return ['wait', 'jobs', operation.jobId, '--cursor', operation.serializedCursor];
    case 'backend-startup':
      return [];
  }
}

function drainStdoutBeforeHandoff(time: TimePort, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolveDrain) => {
    let settled = false;
    let writeReturned = false;
    let callbackComplete = false;
    let drainComplete = false;
    let needsDrain = false;

    const cleanup = (): void => {
      time.clearTimeout(timeout);
      process.stdout.off('drain', onDrain);
      process.stdout.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (stable: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveDrain(stable);
    };
    const finish = (): void => {
      if (writeReturned && callbackComplete && (!needsDrain || drainComplete)) {
        settle(true);
      }
    };
    const onDrain = (): void => {
      drainComplete = true;
      finish();
    };
    const onError = (): void => settle(false);
    const onAbort = (): void => settle(false);
    const timeout = time.setTimeout(() => settle(false), STDOUT_HANDOFF_DRAIN_TIMEOUT_MS);
    timeout.unref?.();

    process.stdout.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const accepted = process.stdout.write('', (error) => {
        if (error) {
          settle(false);
          return;
        }
        callbackComplete = true;
        finish();
      });
      needsDrain = !accepted;
      drainComplete = accepted;
      writeReturned = true;
      if (!settled && !accepted) {
        process.stdout.once('drain', onDrain);
      }
      finish();
    } catch {
      settle(false);
    }
  });
}

type ExecutionThrowPhase = Extract<DirectTerminalDisposition, { kind: 'execution-failed' }>['throwPhase'];

type SelectionPublication =
  | PublicationOutcome
  | Readonly<{
      kind: 'refused';
      refusal: Extract<HandoffRecordingRefusal, { attemptedPhase: 'selection' }>;
    }>;

type TerminalPublication =
  | PublicationOutcome
  | Readonly<{
      kind: 'refused';
      refusal: Extract<HandoffRecordingRefusal, { attemptedPhase: 'terminal' }>;
    }>;

function summarizeBuild(manifest: StrictBundleManifest): BuildSummary {
  return buildSummarySchema.parse({
    version: manifest.version,
    buildSetId: manifest.buildSetId,
    bundleHash: manifest.bundleHash,
    flavor: manifest.flavor,
  });
}

function durableRoutingBasis(basis: HandoffRoutingBasis): DurableHandoffRoutingBasis {
  switch (basis.kind) {
    case 'incumbent-absent':
    case 'incumbent-unresolved':
    case 'incumbent-unusable':
    case 'invoking-identity-unavailable':
    case 'incumbent-identity-unavailable':
    case 'same-build-set':
    case 'invoking-build-not-older':
      return basis;
    case 'invalid-incumbent-target':
      return {
        kind: basis.kind,
        evidence: {
          failure: basis.evidence.failure,
          ...(basis.evidence.expectedManifest === null
            ? {}
            : { expectedBuild: summarizeBuild(basis.evidence.expectedManifest) }),
        },
      };
    default:
      return assertNever(basis);
  }
}

function selectedDisposition(routing: HandoffRoutingResult): SelectedHandoffDisposition {
  switch (routing.kind) {
    case 'continue-current':
      return { kind: 'continue-current', basis: durableRoutingBasis(routing.basis) };
    case 'handoff':
      return {
        kind: 'handoff-selected',
        source: routing.source,
        target: inspectValidatedHandoffTarget(routing.target),
      };
    default:
      return assertNever(routing);
  }
}

function writerIdentity(runtime: Runtime): RecordedProcessIdentity | null {
  try {
    const pid = runtime.env.pid();
    const incarnation = runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform);
    return incarnation === null ? null : { pid, incarnation };
  } catch {
    return null;
  }
}

function observedAt(time: TimePort): string {
  return new Date(time.now()).toISOString();
}

async function publishHandoffTransition(
  runtime: Runtime,
  time: TimePort,
  transition: HandoffRoutingTransition,
  signal?: AbortSignal,
): Promise<PublicationOutcome> {
  const status = await import('./status.js');
  const generation = handoffRoutingStatusGeneration(status.handoffRoutingStatusStoreSchema());
  return status.publishGenerationCoordinatedHandoffRoutingTransitions(
    { ...runtime, time },
    handoffRoutingStatusPathForRunDir(runtime.paths.coral.coordinator.runDir, generation),
    [transition],
    signal,
  );
}

type HandoffPublicationAttempt =
  | Readonly<{ phase: 'selection'; publication: SelectionPublication }>
  | Readonly<{
      phase: 'terminal';
      publication: TerminalPublication;
      terminalDisposition: DirectTerminalDisposition;
    }>;

function recordIncident(
  incidents: HandoffPublicationIncident[],
  invocationId: string,
  attempt: HandoffPublicationAttempt,
): HandoffPublicationIncident | null {
  if (attempt.publication.kind === 'committed') return null;
  const incident: HandoffPublicationIncident =
    attempt.phase === 'selection'
      ? { phase: 'selection', invocationId, ...attempt.publication }
      : {
          phase: 'terminal',
          invocationId,
          terminalDisposition: attempt.terminalDisposition,
          ...attempt.publication,
        };
  incidents.push(incident);
  return incident;
}

async function recordSelection(
  runtime: Runtime,
  time: TimePort,
  routing: HandoffRoutingResult,
  invocationId: string,
  signal?: AbortSignal,
): Promise<SelectionPublication> {
  let disposition: SelectedHandoffDisposition;
  try {
    disposition = selectedDisposition(routing);
  } catch {
    return {
      kind: 'refused',
      refusal: {
        reason: 'invalid-target-authority',
        remediation: 'retry-with-live-target-authority',
        attemptedPhase: 'selection',
      },
    };
  }

  const owner = writerIdentity(runtime);
  if (owner === null) {
    return {
      kind: 'refused',
      refusal: {
        reason: 'owner-identity-unavailable',
        remediation: 'retry-when-process-identity-is-readable',
        attemptedPhase: 'selection',
      },
    };
  }

  return publishHandoffTransition(
    runtime,
    time,
    {
      kind: 'routing-selected',
      eventId: runtime.ids.uuid(),
      invocationId,
      observedAt: observedAt(time),
      owner,
      disposition,
    },
    signal,
  );
}

function finalizedDisposition(continuation: HandoffContinuationResult): DirectTerminalDisposition {
  switch (continuation.kind) {
    case 'run-current':
      switch (continuation.reason.kind) {
        case 'routing':
          return {
            kind: 'continued-current',
            reason: { kind: 'routing', basis: durableRoutingBasis(continuation.reason.basis) },
          };
        case 'handoff-abandoned':
          return { kind: 'continued-current', reason: { kind: 'handoff-abandoned-stdout' } };
        case 'handoff-not-applicable':
          throw new Error('Display-only handoff continuations cannot enter routing-status recording.');
        default:
          return assertNever(continuation.reason);
      }
    case 'delegated':
      switch (continuation.outcome.kind) {
        case 'handoff-success':
          return { kind: 'delegated-success', version: continuation.version };
        case 'handoff-exit':
          return { kind: 'delegated-exit', version: continuation.version, exitCode: continuation.outcome.exitCode };
        case 'handoff-signal':
          return { kind: 'delegated-signal', version: continuation.version, signal: continuation.outcome.signal };
        default:
          return assertNever(continuation.outcome);
      }
    default:
      return assertNever(continuation);
  }
}

async function recordTerminal(
  runtime: Runtime,
  time: TimePort,
  invocationId: string,
  selection: SelectionPublication,
  disposition: DirectTerminalDisposition,
  signal?: AbortSignal,
): Promise<TerminalPublication> {
  if (selection.kind === 'commit-outcome-unknown') {
    return {
      kind: 'refused',
      refusal: {
        reason: 'selection-publication-outcome-unknown',
        remediation: 'inspect-routing-status-before-repair',
        attemptedPhase: 'terminal',
      },
    };
  }

  return publishHandoffTransition(
    runtime,
    time,
    {
      kind: disposition.kind === 'execution-failed' ? 'execution-failed' : 'continuation-finalized',
      eventId: runtime.ids.uuid(),
      invocationId,
      observedAt: observedAt(time),
      selection:
        selection.kind === 'committed'
          ? { kind: 'with-selection-sequence', selectionSequence: selection.sequence }
          : { kind: 'without-selection' },
      disposition,
    },
    signal,
  );
}

async function executeResolvedHandoff(
  operation: HandoffOperation,
  routing: HandoffRoutingResult,
  runtime: Runtime,
  time: TimePort,
  signal: AbortSignal | undefined,
  executionPhase: { current: ExecutionThrowPhase },
): Promise<HandoffContinuationResult> {
  switch (routing.kind) {
    case 'continue-current':
      return { kind: 'run-current', reason: { kind: 'routing', basis: routing.basis } };
    case 'handoff': {
      executionPhase.current = 'double-delegation-guard';
      const guard = operation.kind === 'backend-startup' ? undefined : readCliHandoffGuard();
      if (guard === '1') {
        throw new Error(
          'This Coral build already delegated once and refuses a second delegation, which means two builds ' +
            "are handing off to each other. Run 'coral-cli backend status' and report that output; unsetting " +
            `${CLI_HANDOFF_GUARD_ENV} lets this invocation retry once.`,
        );
      }

      if (operation.kind !== 'backend-startup' && !(await drainStdoutBeforeHandoff(time, signal))) {
        return {
          kind: 'run-current',
          reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
        };
      }

      executionPhase.current = 'target-authority';
      const execution = withValidatedHandoffTarget(routing.target);
      const startup =
        operation.kind === 'backend-startup'
          ? {
              identity: {
                version: execution.manifest.version,
                bundleHash: execution.manifest.bundleHash,
                flavor: execution.manifest.flavor,
                namespace: pluginRootNamespace(dirname(execution.bundleDir)),
              } satisfies StartupAttemptIdentity,
              expectedAttemptId: runtime.env.get('CORAL_STARTUP_ATTEMPT_ID'),
            }
          : undefined;
      const executable = operation.kind === 'backend-startup' ? 'coral-backend.cjs' : 'coral-cli.cjs';
      const childArguments = [join(execution.bundleDir, executable), ...delegatedArguments(operation)];
      const spawnOptions: SpawnOptions = {
        cwd: runtime.env.cwd(),
        env: { ...runtime.env.fullSnapshot(), [CLI_HANDOFF_GUARD_ENV]: '1' },
        stdio: 'inherit',
        ...(operation.kind === 'backend-startup' ? { detached: true } : {}),
      };

      executionPhase.current = 'executable-check';
      execution.assertExecutable();
      executionPhase.current = 'child-spawn';
      const child = spawn(process.execPath, childArguments, spawnOptions);
      const childObservation = observeChild(child);
      await childObservation.spawned;
      executionPhase.current = 'child-outcome-wait';
      if (startup !== undefined) {
        child.unref();
        // A cancellation may not be threaded into this observation: it would have to return while the
        // detached child is still live, and `HandoffOutcome` has no variant that names an unobserved child,
        // so the abandonment would be reported as a success or an exit. Both are false.
        const startupObservation = await waitForBackendStartupObservation(
          childObservation,
          runtime,
          time,
          startup.identity,
          startup.expectedAttemptId,
        );
        return {
          kind: 'delegated',
          version: execution.manifest.version,
          outcome:
            startupObservation.kind === 'ready'
              ? handoffOutcome(execution.manifest.version, { code: 0, signal: null })
              : endedChildOutcome(startupObservation.outcome),
        };
      }
      const outcome = handoffOutcome(execution.manifest.version, await childObservation.outcome);
      return { kind: 'delegated', version: execution.manifest.version, outcome };
    }
    default:
      return assertNever(routing);
  }
}

function collectedIncidents(
  incidents: readonly HandoffPublicationIncident[],
): NonEmptyReadonlyArray<HandoffPublicationIncident> | null {
  return incidents.length === 0
    ? null
    : (Object.freeze([...incidents]) as NonEmptyReadonlyArray<HandoffPublicationIncident>);
}

export async function runHandoff(
  operationInput: HandoffOperation,
  options: RunHandoffOptions = {},
): Promise<HandoffRunResult> {
  const operation = handoffOperationSchema.parse(operationInput) as HandoffOperation;
  if (isDisplayOnlyInvocation(operation)) {
    return {
      kind: 'recording-not-applicable',
      continuationWithoutRecording: {
        kind: 'run-current',
        reason: { kind: 'handoff-not-applicable', reason: 'display-only' },
      },
    };
  }

  const { routing, runtime, time } = await resolveHandoffRoutingForOperation(operation, options);
  const recordingApplicable =
    operation.kind !== 'cli-invocation' ||
    classifyHandoffRoutingStatusOperatorInvocation(operation.argv).kind === 'not-routing-status';
  const executionPhase: { current: ExecutionThrowPhase } = { current: 'double-delegation-guard' };
  if (!recordingApplicable) {
    return {
      kind: 'recording-not-applicable',
      continuationWithoutRecording: await executeResolvedHandoff(
        operation,
        routing,
        runtime,
        time,
        options.signal,
        executionPhase,
      ),
    };
  }

  const invocationId = runtime.ids.uuid();
  const incidents: HandoffPublicationIncident[] = [];
  const selection = await recordSelection(runtime, time, routing, invocationId, options.signal);
  const selectionIncident = recordIncident(incidents, invocationId, { phase: 'selection', publication: selection });
  if (selectionIncident?.phase === 'selection') {
    options.onSelectionPublicationIncident?.(selectionIncident);
  }

  try {
    const continuation = await executeResolvedHandoff(
      operation,
      routing,
      runtime,
      time,
      options.signal,
      executionPhase,
    );
    const terminalDisposition = finalizedDisposition(continuation);
    const terminal = await recordTerminal(runtime, time, invocationId, selection, terminalDisposition, options.signal);
    recordIncident(incidents, invocationId, { phase: 'terminal', terminalDisposition, publication: terminal });
    const publicationIncidents = collectedIncidents(incidents);
    return publicationIncidents === null
      ? { kind: 'recorded', continuation, publicationIncidents: [] }
      : { kind: 'recording-incidents', observedWork: continuation, publicationIncidents };
  } catch (originalError: unknown) {
    const terminalDisposition: DirectTerminalDisposition = {
      kind: 'execution-failed',
      throwPhase: executionPhase.current,
    };
    const terminal = await recordTerminal(runtime, time, invocationId, selection, terminalDisposition, options.signal);
    recordIncident(incidents, invocationId, { phase: 'terminal', terminalDisposition, publication: terminal });
    const publicationIncidents = collectedIncidents(incidents);
    if (publicationIncidents !== null) {
      throw new HandoffRunError(originalError, publicationIncidents);
    }
    throw originalError;
  }
}
