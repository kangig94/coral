import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { providerHandoffCapsulePath } from '../../infra/path/index.js';
import { probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import { createMonotonicClock } from '../../infra/monotonic-clock.js';
import { reapRecordedContainment } from '../../infra/process-containment.js';
import {
  readHandoffCapsuleFile,
  type HandoffCapsule,
  guardianHandoffRedeemFieldsSchema,
  guardianHandoffRedeemParamsSchema,
  proxyHandoffRedeemFieldsSchema,
  proxyHandoffRedeemParamsSchema,
  reaperHandoffRotateFieldsSchema,
} from '../../provider-proxy/handoff-capsule.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  controlEpochSchema,
  heartbeatChallengeSchema,
  type CoordinatorIdentity,
  type OperationIdentity,
  reaperHandoffRotateParamsSchema,
} from '../../provider-proxy/protocol.js';
import type { ControlClient, ProviderEventHandler } from '../../provider-proxy/control-client.js';
import { runtimeControlTimer, type RoleConnectRetryOptions } from '../../provider-proxy/role-spawn.js';
import {
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  providerProxyDisappearanceReceipt,
} from '../../provider-proxy/enforcement.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../provider-proxy/orphan-deadline.js';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import { readProviderOperations } from '../../store/provider-operation-journal.js';
import type { ProviderOperationIdentity, ProviderOperationRecord } from '../../store/provider-operation-record.js';
import {
  ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS,
  ESTABLISH_CONTROL_READY_DEADLINE_MS,
  ESTABLISH_CONTROL_RETRY_INTERVAL_MS,
} from '../live/provider-proxy/acquisition-steps.js';
import { establishRoleControl } from '../live/provider-proxy/role-control.js';
import { createProviderProxySetAuthority } from '../live/provider-proxy/set-authority.js';
import { startHeartbeatLoop, type HeartbeatLoop } from '../live/provider-proxy/heartbeat.js';
import {
  createProviderProxyOperationAuthority,
  notifyProviderProxyControlEstablished,
  type DurableProviderProxyOperationAuthority,
  type ProviderProxyOperationAuthority,
} from '../live/provider-proxy/operation-route.js';
import type { ProviderProxySetAcquisitionIdentity } from '../live/provider-hosts/proxy-set-acquisition.js';
import {
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromRecord,
  providerProxySetIdentitySchema,
  providerProxySetKey,
  type ProviderProxySetIdentity,
} from './provider-proxy-set-identity.js';
import type { ProviderProxyOperationSnapshot } from './operation-registry.js';

/**
 * The branch of proxy-set acquisition that redeems a predecessor's continuously recoverable set instead of
 * spawning a new one. Fresh acquisition installs the role digests and durable capsule before publishing the
 * set; this file is the read half.
 *
 * The capsule is addressable, never discovered: `providerHandoffCapsulePath` hashes `flavor`/`generation`
 * (this successor's own — a grant is build-bound) and `buildSetId`/`hostFingerprint`/`proxyInstanceId` (the
 * locator's — the predecessor's), so there is exactly one path to check, never a scan. Absent, stale, or
 * wrong-identity capsules mean no credential exists for this exact address. Redemption and proof failures
 * remain errors so transport ambiguity cannot be mistaken for authority absence.
 *
 * Lives in `coordinator/services/`, not `coordinator/live/provider-hosts/` (where `DefaultProviderHostManager`,
 * this module's only production caller, itself lives): it composes durable operation locators with a live
 * control capability, which
 * `coordinator/live/**` may not do freely (`architecture-layering.test.ts`'s coordinator-contract-entrypoint
 * rule) — the same reason `provider-proxy-operation-activation.ts` sits here rather than beside the route it
 * backs.
 */

/**
 * The one absolute budget one address's whole redemption attempt — guardian, then reaper, then proxy — may run
 * before `createProviderProxySetInheritance` gives up on it, combined with the recovery
 * walk's own cancellation via `AbortSignal.any` so either one ends the attempt. Three sequential
 * `establishRoleControl` calls each retry up to their own `ESTABLISH_CONTROL_READY_DEADLINE_MS` (10s), so a
 * legitimate attempt against three live-but-slow peers can spend close to three times that — the same
 * reasoning `proxy-set-acquisition.ts`'s `PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS` states for ordinary
 * acquisition's own three-role handshake, restated here rather than imported: the two budgets bound distinct
 * attempts (redemption vs. a fresh spawn) that happen to share this shape, not one shared concept.
 */
const INHERITANCE_REDEMPTION_DEADLINE_MS = 45_000;

export type ProviderProxySetLocator = Readonly<{
  operation: ProviderOperationIdentity;
  locator: ProviderOperationRecord['locator'];
}>;

const controlSessionFields = {
  controlEpoch: controlEpochSchema,
  heartbeatChallenge: heartbeatChallengeSchema,
} as const;

export const guardianHandoffRedeemResultSchema = guardianHandoffRedeemFieldsSchema.extend(controlSessionFields);
export const reaperHandoffRotateResultSchema = reaperHandoffRotateFieldsSchema.extend(controlSessionFields);
export const proxyHandoffRedeemResultSchema = proxyHandoffRedeemFieldsSchema.extend(controlSessionFields);

export type ProviderProxySetInheritanceDeps = Readonly<{
  runtime: Runtime;
  baseDir?: string;
  /** This successor's own wire identity — `pid`/`processStartedAtSeconds` read fresh, matching
   *  `ensureProviderProxySet`'s own coordinator-identity construction. */
  coordinatorIdentity: CoordinatorIdentity;
  operationRegistry: ProviderProxyOperationSnapshot;
  /** Wired onto the redeemed proxy connection exactly as ordinary acquisition wires it onto a freshly opened
   *  one (`ProviderProxyAcquisitionStepsOptions.onProviderEvent`'s own doc). */
  onProviderEvent?(): ProviderEventHandler;
  confirmContainmentDisappearance?: (
    reference: ProviderProxySetLocator,
    db: Database,
    signal: AbortSignal,
  ) => Promise<string | null>;
}>;

export type ProviderProxySetInheritanceOutcome =
  | Readonly<{ kind: 'inherited'; set: DurableProviderProxyOperationAuthority }>
  | Readonly<{ kind: 'containment-disappeared'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'not-bequeathed'; reason: string }>;

const NOTHING_TO_INHERIT_REASON = 'no capsule at this address';

function canonicalOperationSet(operations: readonly OperationIdentity[]): string[] {
  return [
    ...new Set(
      operations.map(
        ({ jobId, operationId, proxyInstanceId, buildSetId }) =>
          `${jobId}:${operationId}:${proxyInstanceId}:${buildSetId}`,
      ),
    ),
  ].sort();
}

/** Redemption agreement is order-insensitive set equality over the complete canonical operation identity:
 *  job, operation, proxy, and build-set UUIDs. Each UUID is canonical and therefore contains no `:`, so the
 *  sorted keys are collision-free and role-specific wire order cannot create a false disagreement. */
function sameOperationSet(left: readonly OperationIdentity[], right: readonly OperationIdentity[]): boolean {
  const canonicalLeft = canonicalOperationSet(left);
  const canonicalRight = canonicalOperationSet(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((operation, index) => operation === canonicalRight[index])
  );
}

/** Every field a capsule read back from disk must agree with the locator that named its address, plus this
 *  successor's own build, because bytes for any other set cannot establish authority over this one. */
function capsuleMatchesLocator(
  capsule: HandoffCapsule,
  reference: ProviderProxySetLocator,
  successor: CoordinatorIdentity,
): boolean {
  const { operation, locator } = reference;
  return (
    capsule.generation === successor.generation &&
    capsule.flavor === successor.flavor &&
    capsule.buildSetId === operation.buildSetId &&
    capsule.hostFingerprint === locator.hostFingerprint &&
    capsule.proxyInstanceId === operation.proxyInstanceId &&
    capsule.guardianInstanceId === locator.guardian.instanceId &&
    capsule.reaperInstanceId === locator.reaper.instanceId &&
    capsule.guardianControlEndpoint === locator.guardian.controlEndpoint &&
    capsule.reaperControlEndpoint === locator.reaper.controlEndpoint &&
    capsule.proxyEndpoint === locator.proxy.controlEndpoint
  );
}

const providerSetDisappearanceClockScope = Symbol('provider-set-disappearance');

async function confirmProviderProxySetDisappearance(
  reference: ProviderProxySetLocator,
  db: Database,
  runtime: Runtime,
  signal: AbortSignal,
): Promise<string | null> {
  const platform = runtime.env.platform() as NodeJS.Platform;
  const enforcerIdentities = [reference.locator.guardian, reference.locator.reaper];
  const enforcerMayStillBeLive = enforcerIdentities.some((identity) => {
    try {
      const observed = probeProcessStartedAtSeconds(identity.pid, platform);
      return (
        observed === identity.processStartedAtSeconds || (observed === null && runtime.process.isAlive(identity.pid))
      );
    } catch {
      return true;
    }
  });
  if (enforcerMayStillBeLive) {
    return null;
  }
  signal.throwIfAborted();

  const roots = new Map<string, Readonly<{ pid: number; processStartedAtSeconds: number }>>();
  for (const record of readProviderOperations(db)) {
    if (
      record.operation.proxyInstanceId !== reference.operation.proxyInstanceId ||
      record.operation.buildSetId !== reference.operation.buildSetId ||
      !('providerRoot' in record)
    ) {
      continue;
    }
    roots.set(`${record.providerRoot.pid}@${record.providerRoot.processStartedAtSeconds}`, record.providerRoot);
  }
  const providerRoots = [...roots.values()];
  const containment = {
    pid: reference.locator.containment.pid,
    processStartedAtSeconds: reference.locator.containment.processStartedAtSeconds,
    processGroupId: reference.locator.containment.processGroupId,
  };
  const clock = createMonotonicClock(providerSetDisappearanceClockScope);
  await reapRecordedContainment(
    containment,
    providerRoots,
    clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
    {
      maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
      clock,
      process: runtime.process,
      platform,
    },
  );
  signal.throwIfAborted();
  return providerProxyDisappearanceReceipt(containment, providerRoots);
}

/**
 * The real redemption sequence throws freely so ambiguous transport outcomes remain retryable rather than
 * becoming evidence that authority or an operation is absent.
 *
 * `signal` is checked between roles and before authority construction, not inside `establishRoleControl` itself: the
 * connect-retry loop it drives (`connectRoleControlWithRetry`) has no signal awareness of its own, the same
 * granularity `acquireProviderProxySet` already accepts for ordinary acquisition (its own `deadlineSignal` is
 * only ever checked between cuts, never inside one). A dead peer still costs up to one role's own connect
 * budget; what this closes is starting the *next* role once the caller has already given up.
 */
async function redeemCapsule(
  capsulePath: string,
  capsule: HandoffCapsule,
  expectedIdentity: ProviderProxySetIdentity | null,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<DurableProviderProxyOperationAuthority> {
  const { runtime, coordinatorIdentity } = deps;
  // A capsule matched, so the socket work below is about to start — refuse to open the first connection at
  // all if the caller has already given up, rather than spending one role's connect budget on an attempt
  // nobody is waiting for.
  signal.throwIfAborted();

  const timer = runtimeControlTimer(runtime);
  const retry: RoleConnectRetryOptions = {
    connectTimeoutMs: ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS,
    retryIntervalMs: ESTABLISH_CONTROL_RETRY_INTERVAL_MS,
    overallDeadlineMs: ESTABLISH_CONTROL_READY_DEADLINE_MS,
    now: () => runtime.time.now(),
    sleep: (ms: number) => runtime.time.sleep(ms),
  };
  const opened: ControlClient[] = [];
  // Declared outside the `try` so the `catch` below can stop whatever this attempt already started, however
  // far it got — an empty array is the correct, safe value for a failure before any heartbeat loop exists.
  let heartbeats: HeartbeatLoop[] = [];

  try {
    // Plan order: guardian first — it is the sole linearization point for the plaintext secret and the party
    // that forwards the redemption receipt to its own paired reaper before this successor ever reaches it.
    const guardianSession = await establishRoleControl(opened, timer, retry, {
      role: 'guardian',
      endpoint: capsule.guardianControlEndpoint,
      openMethod: 'guardian.handoff-redeem.v1',
      openParams: { grantId: capsule.grantId, secret: capsule.secret, successor: coordinatorIdentity },
      openParamsSchema: guardianHandoffRedeemParamsSchema,
      openResultSchema: guardianHandoffRedeemResultSchema,
      identity: (opened) => opened.guardian,
      heartbeatMethod: 'guardian.heartbeat.v1',
      expectedIdentity: {},
    });
    signal.throwIfAborted();

    // Reaper next, presenting the guardian's own receipt — the proof only the guardian could have produced,
    // since only it ever sees the plaintext secret.
    const reaperSession = await establishRoleControl(opened, timer, retry, {
      role: 'reaper',
      endpoint: capsule.reaperControlEndpoint,
      openMethod: 'reaper.handoff-rotate.v1',
      openParams: {
        grantId: capsule.grantId,
        successor: coordinatorIdentity,
        guardianRedemptionReceipt: guardianSession.opened.redemptionReceipt,
      },
      openParamsSchema: reaperHandoffRotateParamsSchema,
      openResultSchema: reaperHandoffRotateResultSchema,
      identity: (opened) => opened.reaper,
      heartbeatMethod: 'reaper.heartbeat.v1',
      expectedIdentity: {},
    });
    signal.throwIfAborted();

    // Proxy last: the one role whose control this successor needs to attach operations and receive
    // `provider.event.v1` on. `onProviderEvent` is wired at connect time here, exactly as ordinary acquisition
    // wires it onto a freshly opened proxy connection.
    const proxySession = await establishRoleControl(opened, timer, retry, {
      role: 'proxy',
      endpoint: capsule.proxyEndpoint,
      openMethod: 'handoff.redeem.v1',
      openParams: {
        grantId: capsule.grantId,
        secret: capsule.secret,
        successor: coordinatorIdentity,
        generation: coordinatorIdentity.generation,
        hostFingerprint: capsule.hostFingerprint,
        buildSetId: capsule.buildSetId,
        proxyInstanceId: capsule.proxyInstanceId,
      },
      openParamsSchema: proxyHandoffRedeemParamsSchema,
      openResultSchema: proxyHandoffRedeemResultSchema,
      identity: (opened) => opened.proxy,
      heartbeatMethod: 'control.heartbeat.v1',
      expectedIdentity: {},
      ...(deps.onProviderEvent === undefined ? {} : { onProviderEvent: deps.onProviderEvent() }),
    });

    if (
      !sameOperationSet(guardianSession.opened.operations, reaperSession.opened.operations) ||
      !sameOperationSet(guardianSession.opened.operations, proxySession.opened.operations)
    ) {
      throw new Error('Guardian, reaper, and proxy redeemed different operation sets.');
    }

    const guardianIdentity = guardianSession.opened.guardian;
    const reaperIdentity = reaperSession.opened.reaper;
    const guardianReportedReaper = guardianSession.opened.reaper;
    const containment = guardianSession.opened.containment;
    const proxyIdentity = proxySession.opened.proxy;
    const setIdentity = providerProxySetIdentitySchema.parse({
      buildSetId: proxyIdentity.buildSetId,
      hostFingerprint: proxyIdentity.hostFingerprint,
      guardianInstanceId: guardianIdentity.guardianInstanceId,
      guardianPid: guardianIdentity.pid,
      guardianProcessStartedAtSeconds: guardianIdentity.processStartedAtSeconds,
      guardianControlEndpoint: guardianIdentity.canonicalControlEndpoint,
      proxyInstanceId: proxyIdentity.proxyInstanceId,
      proxyPid: proxyIdentity.pid,
      reaperInstanceId: reaperIdentity.reaperInstanceId,
      reaperPid: reaperIdentity.pid,
      reaperProcessStartedAtSeconds: reaperIdentity.processStartedAtSeconds,
      reaperControlEndpoint: reaperIdentity.canonicalControlEndpoint,
      containmentKind: reaperIdentity.containmentKind,
      proxyProcessStartedAtSeconds: proxyIdentity.processStartedAtSeconds,
      proxyProcessGroupId: proxyIdentity.processGroupId,
      canonicalEndpoint: proxyIdentity.canonicalEndpoint,
    });
    if (
      JSON.stringify(guardianReportedReaper) !== JSON.stringify(reaperIdentity) ||
      containment.pid !== proxyIdentity.pid ||
      containment.processStartedAtSeconds !== proxyIdentity.processStartedAtSeconds ||
      containment.processGroupId !== proxyIdentity.processGroupId ||
      containment.containmentKind !== reaperIdentity.containmentKind ||
      capsule.buildSetId !== setIdentity.buildSetId ||
      capsule.hostFingerprint !== setIdentity.hostFingerprint ||
      capsule.guardianInstanceId !== setIdentity.guardianInstanceId ||
      capsule.reaperInstanceId !== setIdentity.reaperInstanceId ||
      capsule.proxyInstanceId !== setIdentity.proxyInstanceId ||
      capsule.guardianControlEndpoint !== setIdentity.guardianControlEndpoint ||
      capsule.reaperControlEndpoint !== setIdentity.reaperControlEndpoint ||
      capsule.proxyEndpoint !== setIdentity.canonicalEndpoint
    ) {
      throw new Error('Provider proxy redemption identities disagree with the handoff capsule.');
    }
    if (expectedIdentity !== null && !providerProxySetIdentitiesEqual(expectedIdentity, setIdentity)) {
      throw new Error('Provider proxy redemption identity disagrees with the durable operation record.');
    }

    // Keepalive is already established the moment `establishRoleControl` returns for each role — every one of
    // the three opens above already echoed its own first challenge before this line runs. What starts here is
    // the ongoing renewal past that first echo, exactly mirroring ordinary acquisition's own three loops.
    //
    // A degrading heartbeat is otherwise silent until the enforcer's own deadline fires (`heartbeat.ts`'s own
    // doc) — logged here, per role, so an operator sees it before then.
    const onHeartbeatError = (role: 'guardian' | 'reaper' | 'proxy', instanceId: string) => (error: unknown) => {
      backendLog.warn(`provider-proxy ${role} heartbeat echo failed for ${instanceId}: ${errorMessage(error)}`);
    };
    heartbeats = [
      startHeartbeatLoop(
        guardianSession.client,
        'guardian.heartbeat.v1',
        runtime,
        guardianSession.opened.controlEpoch,
        guardianSession.nextHeartbeatChallenge,
        onHeartbeatError('guardian', guardianIdentity.guardianInstanceId),
      ),
      startHeartbeatLoop(
        reaperSession.client,
        'reaper.heartbeat.v1',
        runtime,
        reaperSession.opened.controlEpoch,
        reaperSession.nextHeartbeatChallenge,
        onHeartbeatError('reaper', reaperIdentity.reaperInstanceId),
      ),
      startHeartbeatLoop(
        proxySession.client,
        'control.heartbeat.v1',
        runtime,
        proxySession.opened.controlEpoch,
        proxySession.nextHeartbeatChallenge,
        onHeartbeatError('proxy', proxyIdentity.proxyInstanceId),
      ),
    ];
    signal.throwIfAborted();

    // Reusing the verified capsule keeps every later epoch bound to the same exact set and protected secret.
    const base = createProviderProxySetAuthority({
      proxyInstanceId: proxyIdentity.proxyInstanceId,
      guardianClient: guardianSession.client,
      proxyClient: proxySession.client,
      reaperClient: reaperSession.client,
      guardianIdentity,
      reaperIdentity,
      proxyIdentityFields: proxyIdentity,
      heartbeats,
      coordinatorIdentity,
      handoffCapsulePath: capsulePath,
      runtime,
      recoveryCapsule: capsule,
      operationRegistry: deps.operationRegistry,
    });
    const set = createProviderProxyOperationAuthority({
      base,
      setIdentity,
      proxyClient: proxySession.client,
      guardianClient: guardianSession.client,
      mutationRpcTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    });

    return set;
  } catch (error: unknown) {
    // Stop every heartbeat loop this attempt started before closing its clients — the mirror image of
    // `createProviderProxySetAuthority`'s own `initiateControlClose` ordering, and the same order ordinary
    // acquisition's undo already uses (`provider-proxy/acquisition-steps.ts`'s `establishControl` undo). A
    // loop left running against a closed client would call `client.call` into an `onError` that logs and
    // continues, forever, on every future heartbeat interval — this attempt failed, so nothing is left to
    // keep alive.
    for (const heartbeat of heartbeats) heartbeat.stop();
    for (const client of opened) client.close();
    throw error;
  }
}

async function redeem(
  reference: ProviderProxySetLocator,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  const { operation, locator } = reference;
  const capsulePath = providerHandoffCapsulePath(
    {
      generation: deps.coordinatorIdentity.generation,
      flavor: deps.coordinatorIdentity.flavor,
      buildSetId: operation.buildSetId,
      hostFingerprint: locator.hostFingerprint,
      proxyInstanceId: operation.proxyInstanceId,
    },
    deps.baseDir === undefined ? undefined : { baseDir: deps.baseDir },
  );
  const capsule = readHandoffCapsuleFile(capsulePath, {
    storage: deps.runtime.storage,
    uid: process.getuid?.() ?? 0,
  });
  if (capsule === null) return { kind: 'not-bequeathed', reason: NOTHING_TO_INHERIT_REASON };
  if (!capsuleMatchesLocator(capsule, reference, deps.coordinatorIdentity)) {
    return { kind: 'not-bequeathed', reason: 'capsule identity disagrees with the committed locator' };
  }
  const set = await redeemCapsule(capsulePath, capsule, providerProxySetIdentityFromRecord(reference), deps, signal);
  return { kind: 'inherited', set };
}

/**
 * Reads the capsule addressed by `locator`'s own `buildSetId`/`hostFingerprint`/`proxyInstanceId` plus this
 * successor's own `generation`/`flavor`, and — only if it is present, matches, and every redemption step
 * accepts it — redeems the whole grant and hands the set to attachment reconciliation. Missing or
 * wrong-identity capsules return `{ kind: 'not-bequeathed' }`; ambiguous redemption failures reject unless
 * exact containment disappearance is proven.
 */
export async function attemptProviderProxySetInheritance(
  locator: ProviderProxySetLocator,
  db: Database,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  let outcome: ProviderProxySetInheritanceOutcome;
  try {
    outcome = await redeem(locator, deps, signal);
  } catch (error: unknown) {
    try {
      const disappearanceReceipt = await deps.confirmContainmentDisappearance?.(locator, db, signal);
      if (disappearanceReceipt !== undefined && disappearanceReceipt !== null) {
        return { kind: 'containment-disappeared', disappearanceReceipt };
      }
    } catch (proofError: unknown) {
      throw new AggregateError(
        [error, proofError],
        `Provider proxy redemption failed and containment disappearance was not proven: ${errorMessage(proofError)}`,
        { cause: proofError },
      );
    }
    throw error;
  }
  if (outcome.kind !== 'not-bequeathed') return outcome;
  try {
    const disappearanceReceipt = await deps.confirmContainmentDisappearance?.(locator, db, signal);
    return disappearanceReceipt === undefined || disappearanceReceipt === null
      ? outcome
      : { kind: 'containment-disappeared', disappearanceReceipt };
  } catch (error: unknown) {
    throw new Error(`${outcome.reason}; containment disappearance was not proven: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/**
 * The narrow capability startup saga reconciliation and generic running-job recovery drive: attempt
 * inheritance for one locator, given only the locator, store, and caller signal. Everything
 * `attemptProviderProxySetInheritance` itself needs beyond that — this coordinator's own wire identity, the
 * operation registry, `onProviderEvent`, and where a
 * successfully redeemed set is registered — is closed over by `createProviderProxySetInheritance` at
 * composition time, mirroring `ProviderProxySetAcquisitionConfig`'s own composed-once shape.
 */
export interface ProviderProxySetInheritance {
  inheritProviderProxySet(
    locator: ProviderProxySetLocator,
    db: Database,
    signal: AbortSignal,
  ): Promise<ProviderProxySetInheritanceOutcome>;
  redeemDiscoveredCapsule(
    capsule: HandoffCapsule,
    capsulePath: string,
    signal: AbortSignal,
  ): Promise<DurableProviderProxyOperationAuthority>;
}

export type CreateProviderProxySetInheritanceOptions = Readonly<{
  runtime: Runtime;
  identity: ProviderProxySetAcquisitionIdentity;
  operationRegistry: ProviderProxyOperationSnapshot;
  onProviderEvent?(): ProviderEventHandler;
  confirmContainmentDisappearance?: ProviderProxySetInheritanceDeps['confirmContainmentDisappearance'];
  /** Where a successfully inherited set is folded in so it participates in this coordinator's own later
   *  shutdown — `DefaultProviderHostManager.registerInheritedSet` in production. */
  registerInheritedSet(set: ProviderProxyOperationAuthority): void;
}>;

/**
 * Composes `attemptProviderProxySetInheritance` with this coordinator's own identity and registries, the same
 * way `world.ts` composes `ProviderProxySetAcquisitionConfig` for ordinary acquisition. This is the one
 * production constructor for `ProviderProxySetInheritance`.
 */
export function createProviderProxySetInheritance(
  options: CreateProviderProxySetInheritanceOptions,
): ProviderProxySetInheritance {
  const inFlightByIdentity = new Map<string, Promise<ProviderProxySetInheritanceOutcome>>();

  const deps = (): ProviderProxySetInheritanceDeps | null => {
    const pid = options.runtime.env.pid();
    const platform = options.runtime.env.platform() as NodeJS.Platform;
    const processStartedAtSeconds = probeProcessStartedAtSeconds(pid, platform);
    if (processStartedAtSeconds === null) return null;
    return {
      runtime: options.runtime,
      coordinatorIdentity: {
        instanceId: options.identity.instanceId,
        pid,
        processStartedAtSeconds,
        generation: 'gen2',
        flavor: options.identity.flavor,
        buildSetId: options.identity.buildSetId,
      },
      operationRegistry: options.operationRegistry,
      confirmContainmentDisappearance:
        options.confirmContainmentDisappearance ??
        ((reference, store, proofSignal) =>
          confirmProviderProxySetDisappearance(reference, store, options.runtime, proofSignal)),
      ...(options.onProviderEvent === undefined ? {} : { onProviderEvent: options.onProviderEvent }),
    };
  };

  return {
    async inheritProviderProxySet(locator, db, signal) {
      const identityKey = providerProxySetKey(providerProxySetIdentityFromRecord(locator));
      const existing = inFlightByIdentity.get(identityKey);
      if (existing !== undefined) return existing;
      const attempt = (async (): Promise<ProviderProxySetInheritanceOutcome> => {
        try {
          const inheritanceDeps = deps();
          let outcome: ProviderProxySetInheritanceOutcome;
          if (inheritanceDeps === null) {
            outcome = { kind: 'not-bequeathed', reason: 'could not read this coordinator process’s own start time' };
          } else {
            // A per-address deadline bounds each redemption without letting one stalled carrier monopolize
            // startup reconciliation.
            const bounded = AbortSignal.any([signal, AbortSignal.timeout(INHERITANCE_REDEMPTION_DEADLINE_MS)]);
            outcome = await attemptProviderProxySetInheritance(locator, db, inheritanceDeps, bounded);
          }
          if (outcome.kind === 'inherited') {
            options.registerInheritedSet(outcome.set);
            notifyProviderProxyControlEstablished(outcome.set);
          }
          return outcome;
        } finally {
          inFlightByIdentity.delete(identityKey);
        }
      })();
      inFlightByIdentity.set(identityKey, attempt);
      return attempt;
    },
    async redeemDiscoveredCapsule(capsule, capsulePath, signal) {
      const inheritanceDeps = deps();
      if (inheritanceDeps === null) {
        throw new Error('could not read this coordinator process’s own start time');
      }
      return redeemCapsule(
        capsulePath,
        capsule,
        null,
        inheritanceDeps,
        AbortSignal.any([signal, AbortSignal.timeout(INHERITANCE_REDEMPTION_DEADLINE_MS)]),
      );
    },
  };
}
