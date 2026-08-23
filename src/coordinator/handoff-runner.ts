import { processIncarnationSchema } from '../infra/node-process.js';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { backendLog } from '../infra/backend-log.js';
import { probeCoordinator, type CoordinatorDiscoveryRecord } from '../infra/backend-discovery.js';
import { resolveBuildFlavor } from '../infra/build-flavor.js';
import {
  readBuildFlavor,
  resolveStrictBundleIdentity,
  strictBundleManifestSchema,
  type StrictBundleManifest,
} from '../infra/bundle-manifest.js';
import {
  createForeignTargetValidator,
  withValidatedHandoffTarget,
  type ForeignTargetValidator,
  type ForeignTargetValidationResult,
  type ValidatedHandoffTarget,
} from '../infra/handoff-target.js';
import { assertNever } from '../infra/error-format.js';
import type { TimePort, TimerHandle } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import { createIpcClient } from '../transport/ipc/client.js';
import {
  HANDOFF_ROUTING_BASIS_OBLIGATIONS,
  routeLiveIncumbent,
  type HandoffRoutingBasis,
  type HandoffRoutingResult,
  type IncumbentIdentitySummary,
  type RoutingBasisObligation,
  type UnresolvedIncumbentCause,
} from './handoff-routing.js';

// The pre-flight's own probe budget. Not `HEALTH_TIMEOUT_MS` from `transport/http/sse.ts`: the coordinator
// topology invariant forbids a coordinator module depending on the HTTP transport, and this bound answers a
// different question — how long a CLI may wait before dispatching without an incumbent.
const INCUMBENT_HEALTH_PROBE_TIMEOUT_MS = 3_000;
const STDOUT_HANDOFF_DRAIN_TIMEOUT_MS = 3_000;
const BACKEND_STARTUP_LIVENESS_CONFIRMATION_MS = 100;
const CLI_HANDOFF_GUARD_ENV = 'CORAL_CLI_HANDOFF_DELEGATED';

const handoffSuccessBrand: unique symbol = Symbol('HandoffSuccess');
const cliHandoffGuardSchema = z.enum(['0', '1']).optional();

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

const liveIncumbentHealthSchema = z
  .object({
    status: z.enum(['starting', 'ok', 'draining']),
    version: z.string().min(1),
    bundleHash: z.string().min(1),
    flavor: z.enum(['prod', 'dev']),
    namespace: z.string().min(1),
    instanceId: z.string().min(1),
    pid: z.number().int().positive(),
    incarnation: processIncarnationSchema.optional(),
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
export const HANDOFF_CONTINUATION_REASON_OBLIGATIONS: Readonly<
  Record<Exclude<HandoffContinuationReason['kind'], 'routing'>, RoutingBasisObligation>
> = {
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
};

export const ABSENT_HANDOFF_RESULT_OBLIGATION: RoutingBasisObligation = {
  requiredDurability: 'ephemeral-allowed',
  requiredRetention: 'until-superseded',
  severity: 'info',
  exitContribution: 0,
};

export type HandoffContinuationResult =
  | Readonly<{ kind: 'run-current'; reason: HandoffContinuationReason }>
  | Readonly<{ kind: 'delegated'; version: string; outcome: HandoffOutcome }>;

export type LiveHandoffContinuationResult = Extract<HandoffContinuationResult, { kind: 'run-current' }>;
export type DelegatedHandoffContinuationResult = Extract<HandoffContinuationResult, { kind: 'delegated' }>;

export function liveHandoffResultObligation(result: LiveHandoffContinuationResult | null): RoutingBasisObligation {
  if (result === null) return ABSENT_HANDOFF_RESULT_OBLIGATION;
  if (result.reason.kind === 'routing') {
    return HANDOFF_ROUTING_BASIS_OBLIGATIONS[result.reason.basis.kind];
  }
  return HANDOFF_CONTINUATION_REASON_OBLIGATIONS[result.reason.kind];
}

export type RunHandoffOptions = Readonly<{
  pluginRoot?: string;
  time?: TimePort;
  signal?: AbortSignal;
  activeSelectionTarget?: ValidatedHandoffTarget;
}>;

type ChildOutcome = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type ObservedChild = Readonly<{
  spawned: Promise<void>;
  outcome: Promise<ChildOutcome>;
}>;

type RoutingResolution = Readonly<{
  routing: HandoffRoutingResult;
  runtime: Pick<Runtime, 'env' | 'paths' | 'storage'>;
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
  return {
    version: health.version,
    bundleHash: health.bundleHash,
    flavor: health.flavor,
    instanceId: health.instanceId,
  };
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
  return Object.freeze({ kind: 'handoff-exit', exitCode: outcome.code ?? 1 });
}

async function observeBackendStartupLiveness(observation: ObservedChild, time: TimePort): Promise<ChildOutcome | null> {
  let timer: TimerHandle | null = null;
  const stillRunning = new Promise<null>((resolveAlive) => {
    timer = time.setTimeout(() => resolveAlive(null), BACKEND_STARTUP_LIVENESS_CONFIRMATION_MS);
  });

  try {
    return await Promise.race([observation.outcome, stillRunning]);
  } finally {
    time.clearTimeout(timer);
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

// A startup handoff delegates or throws; `refuses to continue-current for a startup handoff whose stdout drain
// would fail` enforces this contract.
export function runHandoff(
  operationInput: Readonly<{ kind: 'backend-startup' }>,
  options: RunHandoffOptions & Readonly<{ activeSelectionTarget: ValidatedHandoffTarget }>,
): Promise<DelegatedHandoffContinuationResult>;
export function runHandoff(
  operationInput: HandoffOperation,
  options?: RunHandoffOptions,
): Promise<HandoffContinuationResult>;
export async function runHandoff(
  operationInput: HandoffOperation,
  options: RunHandoffOptions = {},
): Promise<HandoffContinuationResult> {
  const operation = handoffOperationSchema.parse(operationInput) as HandoffOperation;
  const guard = operation.kind === 'backend-startup' ? undefined : readCliHandoffGuard();
  if (isDisplayOnlyInvocation(operation)) {
    return { kind: 'run-current', reason: { kind: 'handoff-not-applicable', reason: 'display-only' } };
  }

  const { routing, runtime, time } = await resolveHandoffRoutingForOperation(operation, options);
  switch (routing.kind) {
    case 'continue-current':
      return { kind: 'run-current', reason: { kind: 'routing', basis: routing.basis } };
    case 'handoff': {
      if (guard === '1') {
        throw new Error(
          'This Coral build already delegated once and refuses a second delegation, which means two builds ' +
            "are handing off to each other. Run 'coral-cli backend status' and report that output; unsetting " +
            `${CLI_HANDOFF_GUARD_ENV} lets this invocation retry once.`,
        );
      }

      if (operation.kind !== 'backend-startup' && !(await drainStdoutBeforeHandoff(time, options.signal))) {
        return {
          kind: 'run-current',
          reason: { kind: 'handoff-abandoned', reason: 'stdout-drain-incomplete' },
        };
      }

      const execution = withValidatedHandoffTarget(routing.target);
      const executable = operation.kind === 'backend-startup' ? 'coral-backend.cjs' : 'coral-cli.cjs';
      const childArguments = [join(execution.bundleDir, executable), ...delegatedArguments(operation)];
      const spawnOptions: SpawnOptions = {
        cwd: runtime.env.cwd(),
        env: { ...runtime.env.fullSnapshot(), [CLI_HANDOFF_GUARD_ENV]: '1' },
        stdio: 'inherit',
        ...(operation.kind === 'backend-startup' ? { detached: true } : {}),
      };

      execution.assertExecutable();
      // Runtime ports do not expose the executable for the current Node process.
      const child = spawn(process.execPath, childArguments, spawnOptions);
      const childObservation = observeChild(child);
      await childObservation.spawned;
      if (operation.kind === 'backend-startup') {
        child.unref();
        // The selected backend starts immediately; this bounded window delays only the retiring delegator and
        // prevents a broken bundle that exits at once from being reported as a successful cold-start handoff.
        const earlyOutcome = await observeBackendStartupLiveness(childObservation, time);
        if (earlyOutcome !== null) {
          const liveCoordinator = await readLiveCoordinatorHealth(runtime, time);
          // Reporting success here is a finalization, so it requires the decisive case: `'observed'`. None of
          // the others — a decisive absence, an unresolved probe, or a live-but-unusable incumbent — may read
          // as confirmation: an early exit-shaped outcome plus a health probe that did not confirm a usable
          // incumbent is not evidence the backend is up.
          return liveCoordinator.kind === 'observed'
            ? {
                kind: 'delegated',
                version: execution.manifest.version,
                outcome: handoffOutcome(execution.manifest.version, { code: 0, signal: null }),
              }
            : { kind: 'delegated', version: execution.manifest.version, outcome: endedChildOutcome(earlyOutcome) };
        }
        return {
          kind: 'delegated',
          version: execution.manifest.version,
          outcome: handoffOutcome(execution.manifest.version, { code: 0, signal: null }),
        };
      }
      const outcome = handoffOutcome(execution.manifest.version, await childObservation.outcome);
      return { kind: 'delegated', version: execution.manifest.version, outcome };
    }
    default:
      return assertNever(routing);
  }
}
