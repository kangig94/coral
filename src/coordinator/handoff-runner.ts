import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import {
  createUseCurrentBackendRouting,
  routeLiveIncumbent,
  type BackendRoutingResult,
} from '../infra/backend-routing.js';
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
import type { TimePort } from '../infra/port-types.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import { createIpcClient } from '../transport/ipc/client.js';

// The pre-flight's own probe budget. Not `HEALTH_TIMEOUT_MS` from `transport/http/sse.ts`: the coordinator
// topology invariant forbids a coordinator module depending on the HTTP transport, and this bound answers a
// different question — how long a CLI may wait before dispatching without an incumbent.
const INCUMBENT_HEALTH_PROBE_TIMEOUT_MS = 3_000;
const STDOUT_HANDOFF_DRAIN_TIMEOUT_MS = 3_000;
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
    processStartedAt: z.number().int().positive().optional(),
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

export type HandoffContinuationResult =
  | Readonly<{ kind: 'run-current' }>
  | Readonly<{ kind: 'delegated'; outcome: HandoffOutcome }>;

export type CanonicalSocketRelease = () => Promise<void>;

export type RunHandoffOptions = Readonly<{
  pluginRoot?: string;
  time?: TimePort;
  signal?: AbortSignal;
  releaseCanonicalSocket?: CanonicalSocketRelease;
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
  routing: BackendRoutingResult;
  runtime: Pick<Runtime, 'env' | 'paths'>;
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
    (discovery.processStartedAt === undefined || discovery.processStartedAt === health.processStartedAt)
  );
}

async function readAuthenticatedHealth(
  discovery: CoordinatorDiscoveryRecord,
  time: TimePort,
): Promise<LiveIncumbentHealth | null> {
  try {
    const value = await createIpcClient(discovery.socketPath, time, {
      kind: 'boot',
      token: discovery.bootToken,
    }).health<unknown>({ timeoutMs: INCUMBENT_HEALTH_PROBE_TIMEOUT_MS });
    const parsed = liveIncumbentHealthSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function routeAuthenticatedHealth(health: LiveIncumbentHealth): BackendRoutingResult {
  const candidate =
    health.manifest === undefined || health.bundleDir === undefined
      ? null
      : Object.freeze({ bundleDir: health.bundleDir, expectedManifest: health.manifest });
  const invokingIdentity = resolveStrictBundleIdentity();
  if (!invokingIdentity.ok || candidate === null) {
    return createUseCurrentBackendRouting({ source: 'live-incumbent' });
  }
  return routeLiveIncumbent({
    invokingManifest: invokingIdentity.manifest,
    incumbent: candidate,
    validateForeignTarget: foreignTargetValidator,
  });
}

async function resolveHandoffRouting(pluginRoot?: string, timePort?: TimePort): Promise<RoutingResolution> {
  const flavor = pluginRoot === undefined ? resolveBuildFlavor(process.env) : readBuildFlavor(pluginRoot);
  const runtime = createRealRuntime(flavor);
  const time = timePort ?? runtime.time;
  const discovery = probeCoordinator({ storage: runtime.storage, env: runtime.env, paths: runtime.paths });
  if (discovery === null) {
    return { routing: createUseCurrentBackendRouting({ source: 'current-build' }), runtime, time };
  }

  const health = await readAuthenticatedHealth(discovery, time);
  if (
    health === null ||
    health.status === 'draining' ||
    !discoveryMatchesHealth(discovery, runtime.paths.coral.coordinator.socketPath, health)
  ) {
    return { routing: createUseCurrentBackendRouting({ source: 'current-build' }), runtime, time };
  }
  return { routing: routeAuthenticatedHealth(health), runtime, time };
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

export async function runHandoff(
  operationInput: HandoffOperation,
  options: RunHandoffOptions = {},
): Promise<HandoffContinuationResult> {
  const operation = handoffOperationSchema.parse(operationInput) as HandoffOperation;
  const guard = operation.kind === 'backend-startup' ? undefined : readCliHandoffGuard();
  if (isDisplayOnlyInvocation(operation)) {
    return { kind: 'run-current' };
  }

  const resolution =
    options.activeSelectionTarget !== undefined
      ? (() => {
          const flavor =
            options.pluginRoot === undefined ? resolveBuildFlavor(process.env) : readBuildFlavor(options.pluginRoot);
          const runtime = createRealRuntime(flavor);
          return {
            routing: { kind: 'handoff', target: options.activeSelectionTarget, source: 'active-selection' } as const,
            runtime,
            time: options.time ?? runtime.time,
          };
        })()
      : operation.kind === 'backend-startup'
        ? (() => {
            throw new Error('Backend startup handoff requires a validated active-store target.');
          })()
        : await resolveHandoffRouting(options.pluginRoot, options.time);
  const { routing, runtime, time } = resolution;
  switch (routing.kind) {
    case 'use-current':
    case 'reset-newer-invalid':
      return { kind: 'run-current' };
    case 'handoff': {
      if (guard === '1') {
        throw new Error(
          'This Coral build already delegated once and refuses a second delegation, which means two builds ' +
            "are handing off to each other. Run 'coral-cli backend status' and report that output; unsetting " +
            `${CLI_HANDOFF_GUARD_ENV} lets this invocation retry once.`,
        );
      }

      if (operation.kind !== 'backend-startup' && !(await drainStdoutBeforeHandoff(time, options.signal))) {
        return { kind: 'run-current' };
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

      await options.releaseCanonicalSocket?.();
      execution.assertExecutable();
      // Runtime ports do not expose the executable for the current Node process.
      const child = spawn(process.execPath, childArguments, spawnOptions);
      const childObservation = observeChild(child);
      await childObservation.spawned;
      if (operation.kind === 'backend-startup') {
        child.unref();
        return {
          kind: 'delegated',
          outcome: handoffOutcome(execution.manifest.version, { code: 0, signal: null }),
        };
      }
      const outcome = handoffOutcome(execution.manifest.version, await childObservation.outcome);
      return { kind: 'delegated', outcome };
    }
  }
}
