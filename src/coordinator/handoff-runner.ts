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
import { readBuildFlavor, resolveStrictBundleIdentity, strictBundleManifestSchema } from '../infra/bundle-manifest.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import type { TimePort } from '../infra/port-types.js';
import { ensure } from '../transport/ipc/ensure.js';
import { createIpcClient } from '../transport/ipc/client.js';
import {
  createForeignTargetValidator,
  withValidatedHandoffTarget,
  type ForeignTargetValidator,
  type ValidatedHandoffTarget,
} from '../infra/handoff-target.js';

// The pre-flight's own probe budget. Not `HEALTH_TIMEOUT_MS` from `transport/http/sse.ts`: the coordinator
// topology invariant forbids a coordinator module depending on the HTTP transport, and this bound answers a
// different question — how long a CLI may wait before dispatching without an incumbent.
const INCUMBENT_HEALTH_PROBE_TIMEOUT_MS = 3_000;

const handoffSuccessBrand: unique symbol = Symbol('HandoffSuccess');

const handoffOperationSchema = z
  .object({
    entrypoint: z.enum(['cli', 'backend']),
    args: z.array(z.string()),
    envAdditions: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const HANDOFF_ENTRYPOINTS = {
  cli: 'coral-cli.cjs',
  backend: 'coral-backend.cjs',
} as const;

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

export type HandoffOperation = Readonly<{
  entrypoint: keyof typeof HANDOFF_ENTRYPOINTS;
  args: readonly string[];
  envAdditions?: Readonly<Record<string, string>>;
}>;

export type HandoffSuccess = Readonly<{
  kind: 'handoff-success';
  version: string;
  [handoffSuccessBrand]: true;
}>;

export type HandoffOutcome =
  | HandoffSuccess
  | Readonly<{ kind: 'handoff-exit'; exitCode: number }>
  | Readonly<{ kind: 'handoff-signal'; signal: NodeJS.Signals }>;

export type CanonicalSocketRelease = () => Promise<void>;

export type RunHandoffOptions = Readonly<{
  runtime: Pick<Runtime, 'env' | 'paths'>;
  target: ValidatedHandoffTarget;
  operation: HandoffOperation;
  releaseCanonicalSocket?: CanonicalSocketRelease;
}>;

type ChildOutcome = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type ObservedChild = Readonly<{
  spawned: Promise<void>;
  outcome: Promise<ChildOutcome>;
}>;

const foreignTargetValidator: ForeignTargetValidator = createForeignTargetValidator();

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
    return createUseCurrentBackendRouting({ source: 'live-incumbent', candidate, invalidTarget: null });
  }
  return routeLiveIncumbent({
    invokingManifest: invokingIdentity.manifest,
    incumbent: candidate,
    validateForeignTarget: foreignTargetValidator,
  });
}

export async function resolveCliHandoffPreflightRouting(
  pluginRoot?: string,
  time?: TimePort,
): Promise<BackendRoutingResult> {
  const flavor = pluginRoot === undefined ? resolveBuildFlavor(process.env) : readBuildFlavor(pluginRoot);
  const runtime = createRealRuntime(flavor);
  const discovery = probeCoordinator({ storage: runtime.storage, env: runtime.env, paths: runtime.paths });
  if (discovery === null) {
    return createUseCurrentBackendRouting({ source: 'current-build' });
  }

  const health = await readAuthenticatedHealth(discovery, time ?? runtime.time);
  if (
    health === null ||
    health.status === 'draining' ||
    !discoveryMatchesHealth(discovery, runtime.paths.coral.coordinator.socketPath, health)
  ) {
    return createUseCurrentBackendRouting({ source: 'current-build' });
  }
  return routeAuthenticatedHealth(health);
}

export async function resolveCliHandoffRouting(pluginRoot?: string, time?: TimePort): Promise<BackendRoutingResult> {
  const client = await ensure(pluginRoot, time, { validateForeignTarget: foreignTargetValidator });
  return client.routing;
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

export async function runHandoff(options: RunHandoffOptions): Promise<HandoffOutcome> {
  const observed = await withValidatedHandoffTarget(options.target, async (execution) => {
    const operation = handoffOperationSchema.parse(options.operation);
    const childArguments = [join(execution.bundleDir, HANDOFF_ENTRYPOINTS[operation.entrypoint]), ...operation.args];
    const spawnOptions: SpawnOptions = {
      cwd: options.runtime.env.cwd(),
      env: { ...options.runtime.env.fullSnapshot(), ...operation.envAdditions },
      stdio: 'inherit',
    };

    await options.releaseCanonicalSocket?.();
    execution.assertExecutable();
    // Runtime ports do not expose the executable for the current Node process.
    const child = spawn(process.execPath, childArguments, spawnOptions);
    const childObservation = observeChild(child);
    await childObservation.spawned;
    return { ...childObservation, version: execution.manifest.version };
  });

  return handoffOutcome(observed.version, await observed.outcome);
}
