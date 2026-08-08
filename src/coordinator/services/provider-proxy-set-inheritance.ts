import { z } from 'zod';

import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { providerHandoffCapsulePath } from '../../infra/path/index.js';
import { probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import type { ProviderOperationRuntimeMeta } from '../../jobs/runtime-meta.js';
import type { ProviderOperationCleanupIdentity } from '../../jobs/contracts/provider-operation-lifecycle.js';
import {
  handoffOperationSetSchema,
  readHandoffCapsuleFile,
  type HandoffCapsule,
  guardianHandoffRedeemParamsSchema,
  proxyHandoffRedeemParamsSchema,
} from '../../provider-proxy/handoff-capsule.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  controlEpochSchema,
  heartbeatChallengeSchema,
  proxyIdentitySchema,
  proxyOperationAdoptParamsSchema,
  proxyOperationStopParamsSchema,
  proxyOperationStopResultSchema,
  type CoordinatorIdentity,
  type GuardianIdentity,
  type OperationIdentity,
  type ReaperIdentity,
  reaperHandoffRotateParamsSchema,
} from '../../provider-proxy/protocol.js';
import type { ControlClient, ProviderEventHandler } from '../../provider-proxy/control-client.js';
import type { ProviderOperationKey } from '../../provider-proxy/ledger.js';
import { runtimeControlTimer, type RoleConnectRetryOptions } from '../../provider-proxy/role-spawn.js';
import type { Runtime } from '../../runtime/ports.js';
import type { Database } from '../../store/db.js';
import { readProviderOperation } from '../../store/provider-operation-journal.js';
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
import { providerOperationRuntimeMeta, type ProviderProxySetIdentity } from './provider-proxy-operation-activation.js';
import type { LocalOperationRegistry, OperationStopControl } from './operation-registry.js';

/**
 * The branch of proxy-set acquisition that redeems a predecessor's bequeathed set instead of spawning a new
 * one. `installHandoffGrant` (`provider-proxy/set-authority.ts`) is the write half — one grant across
 * guardian, reaper and proxy, plus a durable successor capsule; this file is the read half nothing else in the
 * tree has read before now.
 *
 * The capsule is addressable, never discovered: `providerHandoffCapsulePath` hashes `flavor`/`generation`
 * (this successor's own — a grant is build-bound) and `buildSetId`/`hostFingerprint`/`proxyInstanceId` (the
 * locator's — the predecessor's), so there is exactly one path to check, never a scan. Absent, stale,
 * malformed, or wrong-identity all mean "not bequeathed": `attemptProviderProxySetInheritance` never throws
 * out of this module, leaving its caller to preserve pending work or apply ordinary running-job recovery.
 *
 * Lives in `coordinator/services/`, not `coordinator/live/provider-hosts/` (where `DefaultProviderHostManager`,
 * this module's only production caller, itself lives): it composes durable operation locators with a live
 * control capability, which
 * `coordinator/live/**` may not do freely (`architecture-layering.test.ts`'s coordinator-contract-entrypoint
 * rule) — the same reason `provider-proxy-operation-activation.ts` sits here rather than beside the route it
 * backs.
 */

/**
 * The one absolute budget one address's whole redemption attempt — guardian, then reaper, then proxy, then
 * adoption — may run before `createProviderProxySetInheritance` gives up on it, combined with the recovery
 * walk's own cancellation via `AbortSignal.any` so either one ends the attempt. Three sequential
 * `establishRoleControl` calls each retry up to their own `ESTABLISH_CONTROL_READY_DEADLINE_MS` (10s), so a
 * legitimate attempt against three live-but-slow peers can spend close to three times that — the same
 * reasoning `proxy-set-acquisition.ts`'s `PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS` states for ordinary
 * acquisition's own three-role handshake, restated here rather than imported: the two budgets bound distinct
 * attempts (redemption vs. a fresh spawn) that happen to share this shape, not one shared concept.
 */
const INHERITANCE_REDEMPTION_DEADLINE_MS = 45_000;

const adoptResultSchema = z
  .object({ state: z.string().min(1), replayFromProviderSeq: z.number().int().positive().safe() })
  .strict();

export type ProviderProxySetLocator = Pick<
  ProviderOperationRuntimeMeta,
  | 'buildSetId'
  | 'hostFingerprint'
  | 'guardianInstanceId'
  | 'guardianPid'
  | 'guardianProcessStartedAtSeconds'
  | 'guardianControlEndpoint'
  | 'proxyInstanceId'
  | 'proxyPid'
  | 'proxyProcessStartedAtSeconds'
  | 'proxyProcessGroupId'
  | 'canonicalEndpoint'
  | 'reaperInstanceId'
  | 'reaperPid'
  | 'reaperProcessStartedAtSeconds'
  | 'reaperControlEndpoint'
  | 'containmentKind'
>;

const guardianHandoffRedeemResultSchema = z
  .object({
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
    state: z.literal('redeemed-provisional'),
    redemptionReceipt: z.string().min(1),
    operations: handoffOperationSetSchema,
  })
  .strict();

const reaperHandoffRotateResultSchema = z
  .object({
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
    state: z.literal('successor-rotated'),
    reaperRotationReceipt: z.string().min(1),
    operations: handoffOperationSetSchema,
  })
  .strict();

const proxyHandoffRedeemResultSchema = z
  .object({
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
    state: z.literal('redeemed-provisional'),
    redemptionReceipt: z.string().min(1),
    proxy: proxyIdentitySchema,
    operations: handoffOperationSetSchema,
  })
  .strict();

export type ProviderProxySetInheritanceDeps = Readonly<{
  runtime: Runtime;
  /** This successor's own wire identity — `pid`/`processStartedAtSeconds` read fresh, matching
   *  `ensureProviderProxySet`'s own coordinator-identity construction. */
  coordinatorIdentity: CoordinatorIdentity;
  /** Where executing operations are registered after adoption and where stop-and-reap reads live roots. */
  operationRegistry: Pick<LocalOperationRegistry, 'adopt' | 'operationsFor' | 'providerRootsFor'>;
  cleanupIdentityFor(jobId: string): ProviderOperationCleanupIdentity;
  /** Reads the journal afresh when this successor later bequeaths the set again. */
  snapshotProviderOperations?: (proxyInstanceId: string) => readonly ProviderOperationKey[];
  /** Wired onto the redeemed proxy connection exactly as ordinary acquisition wires it onto a freshly opened
   *  one (`ProviderProxyAcquisitionStepsOptions.onProviderEvent`'s own doc). */
  onProviderEvent?(): ProviderEventHandler;
}>;

export type ProviderProxySetInheritanceOutcome =
  | Readonly<{ kind: 'inherited'; set: DurableProviderProxyOperationAuthority; adoptedJobIds: ReadonlySet<string> }>
  | Readonly<{ kind: 'not-bequeathed'; reason: string }>;

/** The one `not-bequeathed` reason that is the ordinary, expected outcome on a coordinator generation that
 *  inherited nothing — most boots reach this without a predecessor having left anything behind. Every other
 *  reason means a capsule was actually found at this exact address before something failed, which a caller
 *  may want to know about. Exported so `recovery/index.ts` can tell the two apart without restating this
 *  literal. */
export const NOTHING_TO_INHERIT_REASON = 'no capsule at this address';

/** Every field a capsule read back from disk must agree with the locator that named its address, plus this
 *  successor's own build — a disagreement on any of them means the bytes at that path (if any) were never
 *  bequeathed to this exact set, however the path happened to be occupied. */
function capsuleMatchesLocator(
  capsule: HandoffCapsule,
  locator: ProviderProxySetLocator,
  successor: CoordinatorIdentity,
): boolean {
  return (
    capsule.generation === successor.generation &&
    capsule.flavor === successor.flavor &&
    capsule.buildSetId === locator.buildSetId &&
    capsule.hostFingerprint === locator.hostFingerprint &&
    capsule.proxyInstanceId === locator.proxyInstanceId &&
    capsule.guardianInstanceId === locator.guardianInstanceId &&
    capsule.reaperInstanceId === locator.reaperInstanceId &&
    capsule.guardianControlEndpoint === locator.guardianControlEndpoint &&
    capsule.reaperControlEndpoint === locator.reaperControlEndpoint &&
    capsule.proxyEndpoint === locator.canonicalEndpoint
  );
}

/** An adopted operation keeps only the live stop capability; durable settlement reconnects by locator. */
function buildAdoptedOperationControl(proxyClient: ControlClient, operation: OperationIdentity): OperationStopControl {
  return {
    async stop(cause) {
      const params = proxyOperationStopParamsSchema.parse({ operation, cause });
      const raw = await proxyClient.call('operation.stop.v1', params, PROXY_CONTROL_RPC_TIMEOUT_MS);
      proxyOperationStopResultSchema.parse(raw);
    },
  };
}

/**
 * Re-establishes proxy ownership for every journal row in the redeemed grant. Only a row whose durable phase
 * is already `executing` enters the live registry; pending publication and cleanup stay under the reconciler.
 */
async function adoptRedeemedOperations(
  proxyClient: ControlClient,
  operations: readonly OperationIdentity[],
  db: Database,
  operationRegistry: Pick<LocalOperationRegistry, 'adopt'>,
  cleanupIdentityFor: (jobId: string) => ProviderOperationCleanupIdentity,
): Promise<ReadonlySet<string>> {
  const adoptedJobIds = new Set<string>();
  for (const operation of operations) {
    const record = readProviderOperation(db, operation);
    if (record === null) continue;
    try {
      const raw = await proxyClient.call(
        'operation.adopt.v1',
        proxyOperationAdoptParamsSchema.parse({
          operation,
          committedThroughProviderSeq:
            record.phase === 'executing' || record.phase === 'settlement-pending'
              ? record.committedThroughProviderSeq
              : 0,
        }),
        PROXY_CONTROL_RPC_TIMEOUT_MS,
      );
      adoptResultSchema.parse(raw);
    } catch {
      continue;
    }
    if (record.phase !== 'executing') continue;
    const meta = providerOperationRuntimeMeta(record);
    operationRegistry.adopt(
      meta,
      buildAdoptedOperationControl(proxyClient, operation),
      cleanupIdentityFor(operation.jobId),
    );
    adoptedJobIds.add(operation.jobId);
  }
  return adoptedJobIds;
}

/**
 * The real redemption sequence, throwing freely — `attemptProviderProxySetInheritance` below is the one
 * boundary that converts every failure here into `not-bequeathed`.
 *
 * `signal` is checked between roles and before adoption, not inside `establishRoleControl` itself: the
 * connect-retry loop it drives (`connectRoleControlWithRetry`) has no signal awareness of its own, the same
 * granularity `acquireProviderProxySet` already accepts for ordinary acquisition (its own `deadlineSignal` is
 * only ever checked between cuts, never inside one). A dead peer still costs up to one role's own connect
 * budget; what this closes is starting the *next* role, or adopting, once the caller has already given up.
 */
async function redeem(
  locator: ProviderProxySetLocator,
  db: Database,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  const { runtime, coordinatorIdentity } = deps;
  const capsulePath = providerHandoffCapsulePath({
    generation: coordinatorIdentity.generation,
    flavor: coordinatorIdentity.flavor,
    buildSetId: locator.buildSetId,
    hostFingerprint: locator.hostFingerprint,
    proxyInstanceId: locator.proxyInstanceId,
  });
  const uid = process.getuid?.() ?? 0;
  const capsule = readHandoffCapsuleFile(capsulePath, { storage: runtime.storage, uid });
  if (capsule === null) return { kind: 'not-bequeathed', reason: NOTHING_TO_INHERIT_REASON };
  if (!capsuleMatchesLocator(capsule, locator, coordinatorIdentity)) {
    return { kind: 'not-bequeathed', reason: 'capsule identity disagrees with the committed locator' };
  }
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
      // Nothing self-reported to verify: redemption echoes no guardian identity fields, only the receipt and
      // the set the grant was installed over. The capsule/locator agreement above already established this is
      // the right guardian.
      identity: () => ({}),
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
      identity: () => ({}),
      heartbeatMethod: 'reaper.heartbeat.v1',
      expectedIdentity: {},
    });
    signal.throwIfAborted();

    // Proxy last: the one role whose control this successor actually needs to adopt operations and receive
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
        hostFingerprint: locator.hostFingerprint,
        buildSetId: locator.buildSetId,
        proxyInstanceId: locator.proxyInstanceId,
      },
      openParamsSchema: proxyHandoffRedeemParamsSchema,
      openResultSchema: proxyHandoffRedeemResultSchema,
      identity: (opened) => opened.proxy,
      heartbeatMethod: 'control.heartbeat.v1',
      expectedIdentity: {
        proxyInstanceId: locator.proxyInstanceId,
        pid: locator.proxyPid,
        processStartedAtSeconds: locator.proxyProcessStartedAtSeconds,
        processGroupId: locator.proxyProcessGroupId,
        guardianInstanceId: locator.guardianInstanceId,
        reaperInstanceId: locator.reaperInstanceId,
        generation: coordinatorIdentity.generation,
        flavor: coordinatorIdentity.flavor,
        buildSetId: locator.buildSetId,
        hostFingerprint: locator.hostFingerprint,
        canonicalEndpoint: locator.canonicalEndpoint,
      },
      ...(deps.onProviderEvent === undefined ? {} : { onProviderEvent: deps.onProviderEvent() }),
    });

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
        onHeartbeatError('guardian', locator.guardianInstanceId),
      ),
      startHeartbeatLoop(
        reaperSession.client,
        'reaper.heartbeat.v1',
        runtime,
        reaperSession.opened.controlEpoch,
        reaperSession.nextHeartbeatChallenge,
        onHeartbeatError('reaper', locator.reaperInstanceId),
      ),
      startHeartbeatLoop(
        proxySession.client,
        'control.heartbeat.v1',
        runtime,
        proxySession.opened.controlEpoch,
        proxySession.nextHeartbeatChallenge,
        onHeartbeatError('proxy', locator.proxyInstanceId),
      ),
    ];
    signal.throwIfAborted();

    const adoptedJobIds = await adoptRedeemedOperations(
      proxySession.client,
      proxySession.opened.operations,
      db,
      deps.operationRegistry,
      deps.cleanupIdentityFor,
    );

    const guardianIdentity: GuardianIdentity = {
      guardianInstanceId: locator.guardianInstanceId,
      pid: locator.guardianPid,
      processStartedAtSeconds: locator.guardianProcessStartedAtSeconds,
      generation: coordinatorIdentity.generation,
      flavor: coordinatorIdentity.flavor,
      buildSetId: locator.buildSetId,
      hostFingerprint: locator.hostFingerprint,
      canonicalControlEndpoint: locator.guardianControlEndpoint,
    };
    const reaperIdentity: ReaperIdentity = {
      reaperInstanceId: locator.reaperInstanceId,
      pid: locator.reaperPid,
      processStartedAtSeconds: locator.reaperProcessStartedAtSeconds,
      guardianInstanceId: locator.guardianInstanceId,
      generation: coordinatorIdentity.generation,
      flavor: coordinatorIdentity.flavor,
      buildSetId: locator.buildSetId,
      hostFingerprint: locator.hostFingerprint,
      canonicalControlEndpoint: locator.reaperControlEndpoint,
      containmentKind: locator.containmentKind,
    };
    const proxyIdentity = proxySession.opened.proxy;

    // This successor's own future handoff capsule for this exact set, should it too shut down in handoff
    // mode: `buildSetId`/`generation`/`flavor` are this coordinator's own (proven equal to the locator's and
    // the capsule's by the redemption that just succeeded — a grant is build-bound), and `proxyInstanceId` is
    // unchanged by inheritance, so this resolves to the identical address this redemption just read from. A
    // set can be bequeathed more than once: overwriting the just-consumed capsule at that address with a
    // fresh grant is exactly correct, not a collision.
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
      snapshotProviderOperations:
        deps.snapshotProviderOperations ??
        (() => {
          throw new Error('Durable provider-operation handoff membership is unavailable.');
        }),
      operationRegistry: deps.operationRegistry,
    });
    const setIdentity: ProviderProxySetIdentity = {
      buildSetId: locator.buildSetId,
      hostFingerprint: locator.hostFingerprint,
      guardianInstanceId: locator.guardianInstanceId,
      guardianPid: locator.guardianPid,
      guardianProcessStartedAtSeconds: locator.guardianProcessStartedAtSeconds,
      guardianControlEndpoint: locator.guardianControlEndpoint,
      proxyInstanceId: locator.proxyInstanceId,
      proxyPid: locator.proxyPid,
      reaperInstanceId: locator.reaperInstanceId,
      reaperPid: locator.reaperPid,
      reaperProcessStartedAtSeconds: locator.reaperProcessStartedAtSeconds,
      reaperControlEndpoint: locator.reaperControlEndpoint,
      containmentKind: locator.containmentKind,
      proxyProcessStartedAtSeconds: locator.proxyProcessStartedAtSeconds,
      proxyProcessGroupId: locator.proxyProcessGroupId,
      canonicalEndpoint: locator.canonicalEndpoint,
    };
    const set = createProviderProxyOperationAuthority({
      base,
      setIdentity,
      proxyClient: proxySession.client,
      guardianClient: guardianSession.client,
      mutationRpcTimeoutMs: PROXY_CONTROL_RPC_TIMEOUT_MS,
    });

    return { kind: 'inherited', set, adoptedJobIds };
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

/**
 * Reads the capsule addressed by `locator`'s own `buildSetId`/`hostFingerprint`/`proxyInstanceId` plus this
 * successor's own `generation`/`flavor`, and — only if it is present, matches, and every redemption step
 * accepts it — redeems the whole grant and adopts every operation it names. Never rejects: absent, stale,
 * malformed, or wrong-identity all collapse to `{ kind: 'not-bequeathed' }`; pending saga callers retain
 * their rows, while running-job recovery may continue to carrier-detached handling.
 */
export async function attemptProviderProxySetInheritance(
  locator: ProviderProxySetLocator,
  db: Database,
  deps: ProviderProxySetInheritanceDeps,
  signal: AbortSignal,
): Promise<ProviderProxySetInheritanceOutcome> {
  try {
    return await redeem(locator, db, deps, signal);
  } catch (error: unknown) {
    return { kind: 'not-bequeathed', reason: error instanceof Error ? error.message : String(error) };
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
}

export type CreateProviderProxySetInheritanceOptions = Readonly<{
  runtime: Runtime;
  identity: ProviderProxySetAcquisitionIdentity;
  operationRegistry: Pick<LocalOperationRegistry, 'adopt' | 'operationsFor' | 'providerRootsFor'>;
  cleanupIdentityFor(jobId: string): ProviderOperationCleanupIdentity;
  snapshotProviderOperations?: (proxyInstanceId: string) => readonly ProviderOperationKey[];
  onProviderEvent?(): ProviderEventHandler;
  /** Where a successfully inherited set is folded in so it participates in this coordinator's own later
   *  shutdown — `DefaultProviderHostManager.registerInheritedSet` in production. */
  registerInheritedSet(set: ProviderProxyOperationAuthority): void;
}>;

function providerProxySetAddress(locator: ProviderProxySetLocator): string {
  return `${locator.buildSetId}:${locator.hostFingerprint}:${locator.proxyInstanceId}`;
}

/**
 * Composes `attemptProviderProxySetInheritance` with this coordinator's own identity and registries, the same
 * way `world.ts` composes `ProviderProxySetAcquisitionConfig` for ordinary acquisition. This is the one
 * production constructor for `ProviderProxySetInheritance`.
 */
export function createProviderProxySetInheritance(
  options: CreateProviderProxySetInheritanceOptions,
): ProviderProxySetInheritance {
  // A grant is single-use, while startup saga recovery and the following running-job pass can name the same
  // set; sharing the successful outcome prevents the second owner from treating a consumed capsule as loss.
  const inheritedByAddress = new Map<string, Promise<ProviderProxySetInheritanceOutcome>>();
  return {
    async inheritProviderProxySet(locator, db, signal) {
      const address = providerProxySetAddress(locator);
      const existing = inheritedByAddress.get(address);
      if (existing !== undefined) return existing;
      const attempt = (async (): Promise<ProviderProxySetInheritanceOutcome> => {
        const pid = options.runtime.env.pid();
        const platform = options.runtime.env.platform() as NodeJS.Platform;
        const processStartedAtSeconds = probeProcessStartedAtSeconds(pid, platform);
        let outcome: ProviderProxySetInheritanceOutcome;
        if (processStartedAtSeconds === null) {
          outcome = { kind: 'not-bequeathed', reason: 'could not read this coordinator process’s own start time' };
        } else {
          // Bounded and interruptible: either this address's own deadline or the caller's recovery-walk signal
          // ends the attempt, whichever comes first — mirroring `ensureProviderProxySet`'s own `deadlineSignal`
          // for ordinary acquisition, plus the caller cancellation ordinary acquisition never needed (it is
          // fire-and-forget; this is not — `runRecoveryAdoption` awaits it before any running job can be decided
          // carrier-detached).
          const bounded = AbortSignal.any([signal, AbortSignal.timeout(INHERITANCE_REDEMPTION_DEADLINE_MS)]);
          outcome = await attemptProviderProxySetInheritance(
            locator,
            db,
            {
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
              cleanupIdentityFor: options.cleanupIdentityFor,
              snapshotProviderOperations: options.snapshotProviderOperations,
              ...(options.onProviderEvent === undefined ? {} : { onProviderEvent: options.onProviderEvent }),
            },
            bounded,
          );
        }
        if (outcome.kind === 'inherited') {
          options.registerInheritedSet(outcome.set);
          notifyProviderProxyControlEstablished(outcome.set);
        } else {
          inheritedByAddress.delete(address);
        }
        return outcome;
      })();
      inheritedByAddress.set(address, attempt);
      return attempt;
    },
  };
}
