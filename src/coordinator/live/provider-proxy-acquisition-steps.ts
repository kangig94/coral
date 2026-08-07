import { z } from 'zod';

import { BUILD_FLAVOR_ENV_KEY } from '../../infra/build-flavor.js';
import { probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import { ABSENCE_POLL_MS } from '../../infra/process-containment.js';
import { PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS } from '../../providers/app-server-transport.js';
import {
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerHandoffCapsulePath,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
  type ProviderProxyEndpointEnvironment,
} from '../../infra/path/index.js';
import type { Runtime } from '../../runtime/ports.js';
import {
  createProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProviderBootstrapCapsuleEnvironment,
  type ProxyBootstrapCapsule,
  type ReaperBootstrapCapsule,
} from '../../provider-proxy/bootstrap-capsule.js';
import {
  handoffSecretDigest,
  writeHandoffCapsuleFile,
  type HandoffCapsule,
} from '../../provider-proxy/handoff-capsule.js';
import type { ProviderOperationKey } from '../../provider-proxy/ledger.js';
import type { ProviderProxyOperationSnapshot } from '../services/operation-registry.js';
import {
  connectRoleControlWithRetry,
  runtimeControlTimer,
  spawnRoleProcess,
  type RoleConnectRetryOptions,
  type RoleSpawnPorts,
  type SpawnedRoleProcess,
} from '../../provider-proxy/role-spawn.js';
import { DETACHED_CONTAINMENT_KIND } from '../../provider-proxy/guardian.js';
import type { ControlClient, ProviderEventHandler } from '../../provider-proxy/control-client.js';
import {
  PROXY_CONTROL_HEARTBEAT_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  resolveProviderProxyDeadlineConfiguration,
} from '../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  canonicalUuidSchema,
  guardianIdentitySchema,
  proxyIdentitySchema,
  reaperIdentitySchema,
  type CoordinatorIdentity,
  type GuardianIdentity,
  type ProxyIdentity,
  type ReaperIdentity,
} from '../../provider-proxy/protocol.js';
import type { AcquisitionUndo, ProviderProxyAcquisitionSteps } from './provider-proxy-acquisition.js';
import type { ProviderProxySetAuthority } from './provider-proxy-authority.js';
import {
  createProviderProxyOperationAuthority,
  type ProviderProxyOperationAuthority,
} from './provider-proxy-operation-route.js';
import type { ProviderProxySetIdentity } from '../services/provider-proxy-operation-activation.js';

/**
 * The production implementation of `ProviderProxyAcquisitionSteps`: mints one guardian/reaper/proxy set's
 * identities and capsules, spawns the detached guardian, and establishes authenticated control on all three
 * endpoints. Each method depends on state the previous one produced — capsule paths on minted identities,
 * control on a spawned guardian — so calling them out of order (or `establishControl` before `spawnGuardian`
 * has run) is a caller defect, not a recoverable outcome; `acquireProviderProxySet` never does this.
 *
 * Every RPC response is parsed with a strict schema before this file trusts a single field of it — a peer's
 * bytes are wire input like any other, and a raw object cast here would forward unvalidated shapes straight
 * into the next role's open request (see `establishRoleControl`) or report a malformed teardown as success
 * (see `createProviderProxySetAuthority`'s `stopAndReap`).
 */

// Exported for `services/provider-proxy-set-inheritance.ts`: redemption dials the same three role endpoints this
// file's own `establishControl` does, on the identical connect-retry budget, so a redeemed tenancy and a
// freshly spawned one time out the same way rather than silently drifting apart.
export const ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS = 2_000;
export const ESTABLISH_CONTROL_RETRY_INTERVAL_MS = 20;
export const ESTABLISH_CONTROL_READY_DEADLINE_MS = 10_000;

/**
 * The one mutation-RPC timeout `activateProviderOperation` (`coordinator/services/provider-proxy-operation-
 * activation.ts`) uses for its whole closed publication order: `operation.prepare.v1`, both activation calls,
 * and their compensation. `operation.prepare.v1` alone can legitimately spend a full app-server cold start
 * (`PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS`) plus the guardian round trip `stageProviderRoot` chains through it
 * (`PROXY_CONTROL_RPC_TIMEOUT_MS`) — the proxy's own `operation.prepare.v1` is declared `budgetMs:
 * 'caller-deadline'` for exactly this reason (`proxy.ts`), so it is this caller-side timeout, not the
 * endpoint's, that now bounds it. A flat `PROXY_CONTROL_RPC_TIMEOUT_MS` ceiling here — the value every other,
 * genuinely-short call in that sequence also used — abandoned a legitimate cold start client-side before the
 * proxy could ever finish it, leaving the untracked app-server child and guardian root registration nothing
 * ever released. The four calls share one timeout rather than four because `activateProviderOperation`'s own
 * body applies one value to all of them; the other three settle in milliseconds in the ordinary case, so
 * sizing the shared ceiling for the one call that can legitimately run long costs them nothing.
 */
export const PROXY_OPERATION_ACTIVATION_RPC_TIMEOUT_MS =
  PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS + PROXY_CONTROL_RPC_TIMEOUT_MS;

export type ProviderProxyAcquisitionStepsOptions = Readonly<{
  runtime: Runtime;
  pluginRoot: string;
  /** This coordinator's own identity — the set's `buildSetId`/`generation`/`flavor` are its own, since every
   *  role dispatches from the exact same backend artifact this coordinator is running. */
  coordinatorIdentity: CoordinatorIdentity;
  /** Resolved by the host spec this set is being acquired for; not this file's concern to derive. */
  hostFingerprint: string;
  /** Overrides the capsule/endpoint path base directory; defaults to the real `~/.coral` tree. Tests pass a
   *  scoped temp directory so they never touch real user state. */
  baseDir?: string;
  /** Injected for tests; defaults to the real per-platform `/proc` or `ps` probe. This file only spawns the
   *  guardian — it never consumes a capsule itself, so it has no strict-identity check to inject. */
  readProcessStartedAtSeconds?(pid: number, platform: NodeJS.Platform): number | null;
  /** This coordinator's own live operations — `installHandoffGrant`'s snapshot source
   *  (`createProviderProxySetAuthority`'s `snapshotOperations`), and the provider roots recorded against
   *  them — `stopAndReap`'s own half of the set-agreement both enforcers require
   *  (`ProviderProxySetAuthorityDependencies`'s own doc). */
  operationRegistry: ProviderProxyOperationSnapshot;
  /** Builds the durable-effect handler for `provider.event.v1`, called once `establishControl` is about to
   *  open the proxy role's connection — see `ProviderProxySetAcquisitionConfig.onProviderEvent`'s own doc for
   *  why this is a factory rather than an already-built handler. Absent wires no handler at all onto that
   *  connection, matching every acquisition attempt that does not care about proxied event application. */
  onProviderEvent?(): ProviderEventHandler;
}>;

type MintedSet = Readonly<{
  guardianInstanceId: string;
  reaperInstanceId: string;
  proxyInstanceId: string;
  guardianEndpoint: string;
  reaperEndpoint: string;
  proxyEndpoint: string;
  guardianCapsulePath: string;
  reaperCapsulePath: string;
  proxyCapsulePath: string;
  guardianBootstrapNonce: string;
  reaperBootstrapNonce: string;
  proxyBootstrapNonce: string;
  guardianReaperAuthSecret: string;
  proxyGuardianAuthSecret: string;
}>;

const heartbeatChallengeSchema = z.string().min(1);
const controlEpochSchema = z.number().int().nonnegative().safe();

/** `<role>.open.v1`'s reply shape: the endpoint always merges the freshly minted `controlEpoch` and first
 *  `heartbeatChallenge` around exactly one role-identity field (see `control-endpoint.ts`'s `establishControl`
 *  — `{ ...fields, controlEpoch, heartbeatChallenge }`), so these three schemas are that pairing per role,
 *  not independent shapes. */
const proxyOpenResultSchema = z
  .object({
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
    proxy: proxyIdentitySchema,
  })
  .strict();
const guardianOpenResultSchema = z
  .object({
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
    guardian: guardianIdentitySchema,
    proxy: proxyIdentitySchema,
  })
  .strict();
const reaperOpenResultSchema = z
  .object({
    controlEpoch: controlEpochSchema,
    heartbeatChallenge: heartbeatChallengeSchema,
    reaper: reaperIdentitySchema,
  })
  .strict();
const heartbeatResultSchema = z
  .object({ state: z.literal('active'), nextHeartbeatChallenge: heartbeatChallengeSchema })
  .strict();
const stopAndReapResultSchema = z
  .object({ state: z.literal('containment-absent'), disappearanceReceipt: z.string().min(1) })
  .strict();

const handoffInstallAckSchema = z
  .object({ state: z.literal('installed-dormant'), grantId: canonicalUuidSchema })
  .strict();

async function heartbeatOnce(
  client: ControlClient,
  method: string,
  controlEpoch: number,
  heartbeatChallenge: string,
): Promise<{ nextHeartbeatChallenge: string }> {
  const raw = await client.call(method, { controlEpoch, heartbeatChallenge }, PROXY_CONTROL_RPC_TIMEOUT_MS);
  return heartbeatResultSchema.parse(raw);
}

export type HeartbeatLoop = Readonly<{ stop(): void }>;

/** Keeps one established tenancy alive past its lease by echoing the challenge on the endpoint's own
 *  heartbeat interval. A failed echo is reported but not retried early — the enforcer's own deadline, not
 *  this loop, is what bounds the fallout of a tenancy that cannot be refreshed. Exported so
 *  `services/provider-proxy-set-inheritance.ts` keeps a redeemed tenancy alive the identical way a freshly
 *  established one is kept alive here — one heartbeat mechanism, not two. */
export function startHeartbeatLoop(
  client: ControlClient,
  method: string,
  runtime: Runtime,
  controlEpoch: number,
  firstNextChallenge: string,
  onError: (error: unknown) => void,
): HeartbeatLoop {
  let challenge = firstNextChallenge;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const beat = await heartbeatOnce(client, method, controlEpoch, challenge);
      challenge = beat.nextHeartbeatChallenge;
    } catch (error: unknown) {
      onError(error);
    }
  };
  const handle = runtime.time.setInterval(() => {
    void tick();
  }, PROXY_CONTROL_HEARTBEAT_MS);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      runtime.time.clearInterval(handle);
    },
  };
}

/** Compares only the fields this acquisition can independently verify — everything it minted, plus (for the
 *  guardian alone) the pid and start time this file observed by spawning it itself. A disagreement here
 *  means the connected process is not the one this acquisition created. */
function assertIdentityFieldsAgree(
  role: string,
  expected: Readonly<Record<string, string | number>>,
  actual: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(
        `${role} identity disagreement on ${key}: this acquisition issued ${String(value)}, the process reported ${String(actual[key])}.`,
      );
    }
  }
}

export type ControlTimer = ReturnType<typeof runtimeControlTimer>;

/** One role's connect→open→verify→heartbeat plan. `identity` pulls the role's own identity field out of the
 *  already-schema-validated open result — a selector rather than a `result[role]` lookup, so the compiler
 *  checks it against the concrete open-result type instead of trusting a string key at runtime. Exported so
 *  `services/provider-proxy-set-inheritance.ts` can describe its own redeem/rotate opens the same shape
 *  `establishRoleControl` already consumes, rather than a second, parallel plan type. */
export type RoleControlPlan<TOpened extends { controlEpoch: number; heartbeatChallenge: string }> = Readonly<{
  role: string;
  endpoint: string;
  openMethod: string;
  openParams: Record<string, unknown>;
  openResultSchema: z.ZodType<TOpened>;
  identity: (opened: TOpened) => Record<string, unknown>;
  heartbeatMethod: string;
  expectedIdentity: Readonly<Record<string, string | number>>;
  /** Only the proxy role ever pushes `provider.event.v1` back over this connection (`protocol.ts`'s own
   *  doc), so only the proxy's plan supplies this. */
  onProviderEvent?: ProviderEventHandler;
}>;

/**
 * Connects one role's control endpoint, opens it, verifies the identity it reports against what this
 * acquisition expects, and sends the first heartbeat — the sequence every one of the three roles goes
 * through in the same order, differing only in which method/params/schema/expected-identity apply.
 *
 * `opened` is mutated (the connected client is pushed the moment it exists, before anything can fail) so the
 * caller's own try/catch can still close every role connected so far, including this one, on a later
 * failure — the same close-everything-opened behavior a single inline try/catch gave when this was one block
 * per role instead of one shared function.
 *
 * Exported: `services/provider-proxy-set-inheritance.ts` drives the identical connect→open→verify→heartbeat
 * sequence for a redeemed tenancy (`guardian.handoff-redeem.v1`, `reaper.handoff-rotate.v1`,
 * `handoff.redeem.v1`) that this file drives for a freshly minted one — the opening credential differs, the
 * mechanics do not, so there is exactly one function that dials a role and keeps its first challenge alive.
 */
export async function establishRoleControl<TOpened extends { controlEpoch: number; heartbeatChallenge: string }>(
  opened: ControlClient[],
  timer: ControlTimer,
  retry: RoleConnectRetryOptions,
  plan: RoleControlPlan<TOpened>,
): Promise<Readonly<{ client: ControlClient; opened: TOpened; nextHeartbeatChallenge: string }>> {
  const client = await connectRoleControlWithRetry(plan.endpoint, timer, retry, plan.onProviderEvent);
  opened.push(client);
  const raw = await client.call(plan.openMethod, plan.openParams, PROXY_CONTROL_RPC_TIMEOUT_MS);
  const result = plan.openResultSchema.parse(raw);
  assertIdentityFieldsAgree(plan.role, plan.expectedIdentity, plan.identity(result));
  const beat = await heartbeatOnce(client, plan.heartbeatMethod, result.controlEpoch, result.heartbeatChallenge);
  return { client, opened: result, nextHeartbeatChallenge: beat.nextHeartbeatChallenge };
}

/** Lets `signal` cut a pending call short without requiring `ControlClient.call` itself to understand
 *  `AbortSignal` — it only ever takes a millisecond budget. If the signal wins the race the pending call is
 *  left to settle on its own; `stopAndReap`'s caller treats a lost race and a rejected call identically
 *  (both become `{ unconfirmed }`), so there is nothing further to do with it either way. */
function raceAgainstAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('the caller deadline elapsed before stop-and-reap confirmed absence'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    pending.then(resolve, reject);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type ProviderProxySetAuthorityDependencies = Readonly<{
  proxyInstanceId: string;
  guardianClient: ControlClient;
  proxyClient: ControlClient;
  reaperClient: ControlClient;
  guardianIdentity: GuardianIdentity;
  reaperIdentity: ReaperIdentity;
  proxyIdentityFields: ProxyIdentity;
  heartbeats: readonly HeartbeatLoop[];
  /** This coordinator's own identity — named on every install call so a peer that checks it (build match
   *  only; see `assertNamedCoordinatorBuild`) can report a disagreement instead of installing blind. */
  coordinatorIdentity: CoordinatorIdentity;
  /** Where `installHandoffGrant` writes this set's one successor capsule. Precomputed by the caller
   *  (`establishControl`), which already resolves `baseDir`/generation/flavor the same way every other
   *  proxy-role path in this file does. */
  handoffCapsulePath: string;
  /** `ids`/`env`/`storage` for minting the grant and writing its capsule durably. */
  runtime: Pick<Runtime, 'ids' | 'env' | 'storage'>;
  /** `snapshotOperations`' source: this coordinator's own live operations, filtered to this proxy. Also
   *  `stopAndReap`'s source for the provider roots it must name in agreement with what each enforcer
   *  actually recorded (`assertRecordedSetAgreement`) — see `ProviderProxyOperationSnapshot`'s own doc. */
  operationRegistry: ProviderProxyOperationSnapshot;
}>;

/**
 * Builds the `ProviderProxySetAuthority` shutdown sees, from three already-established role sessions. Split
 * out from `establishControl` so it takes clients and identities as plain inputs rather than reaching into
 * that function's closure — the same shape that lets a test drive `stopAndReap`/`installHandoffGrant` with a
 * fake `ControlClient` instead of a real socket handshake.
 */
export function createProviderProxySetAuthority(
  deps: ProviderProxySetAuthorityDependencies,
): ProviderProxySetAuthority {
  const {
    proxyInstanceId,
    guardianClient,
    proxyClient,
    reaperClient,
    guardianIdentity,
    reaperIdentity,
    proxyIdentityFields,
    heartbeats,
    coordinatorIdentity,
    handoffCapsulePath,
    runtime,
    operationRegistry,
  } = deps;

  return {
    proxyInstanceId,
    // Taken once per proxy (shutdown.ts calls this exactly once, then hands the fixed result to
    // `installHandoffGrant`) from this coordinator's own live-operation bookkeeping — the same registry
    // `provider-proxy-operation-activation.ts` writes at `operation.activate.v1` ACK. Byte-sorted here so the
    // contract this method documents holds independent of what `installHandoffGrant` does with it.
    snapshotOperations: async () =>
      [...operationRegistry.operationsFor(proxyInstanceId)]
        .map((identity) => ({ jobId: identity.jobId, operationId: identity.operationId }))
        .sort((left, right) =>
          left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
        ),
    installHandoffGrant: async (operations: readonly ProviderOperationKey[], signal: AbortSignal) => {
      if (operations.length === 0) {
        throw new Error('installHandoffGrant requires at least one operation to install a grant over.');
      }
      signal.throwIfAborted();

      // Byte-sorted by operationId: the wire schema (`handoffOperationSetSchema`) requires it and this is
      // the one place that assembles the set, so sorting happens here rather than being asked of every caller.
      //
      // Not re-confirmed against the proxy's own `operation.status.v1` first. That query used to gate the
      // whole install on every named operation still being live and carrier-eligible, refusing the entire
      // grant — for every operation on this proxy — the instant one had already gone stale. A successor
      // learns the identical fact for free and per-operation the moment it tries to adopt: `operation.adopt.v1`
      // answers `operation_not_found` for exactly this proxy no longer holding it, so the whole-set refusal
      // bought nothing a narrower, later, isolated failure did not already cover — and cost every other
      // operation in the set a handoff it would otherwise have gotten cleanly.
      const handoffOperations = [...operations]
        .sort((left, right) =>
          left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
        )
        .map((key) => ({
          jobId: key.jobId,
          operationId: key.operationId,
          proxyInstanceId,
          buildSetId: guardianIdentity.buildSetId,
        }));

      const deadlineConfig = resolveProviderProxyDeadlineConfiguration(runtime.env);
      const grantId = runtime.ids.uuid();
      const secret = runtime.ids.randomBytes(32).toString('hex');
      const secretSha256 = handoffSecretDigest(secret);

      // All three authorities install the identical value or none of them do: a caller that reaps this set
      // after any one install fails leaves nothing to unwind, since `GrantRegistry.install` is idempotent for
      // the exact same value and the containment is about to be torn down regardless of how far this got.
      await Promise.all([
        guardianClient.call(
          'guardian.handoff-install.v1',
          {
            grantId,
            secretSha256,
            successor: coordinatorIdentity,
            operations: handoffOperations,
            orphanTimeoutMs: deadlineConfig.orphanTimeoutMs,
            teardownReserveMs: deadlineConfig.teardownReserveMs,
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        ),
        reaperClient.call(
          'reaper.handoff-install.v1',
          {
            grantId,
            secretSha256,
            successor: coordinatorIdentity,
            operations: handoffOperations,
            orphanTimeoutMs: deadlineConfig.orphanTimeoutMs,
            teardownReserveMs: deadlineConfig.teardownReserveMs,
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        ),
        proxyClient.call(
          'handoff.install.v1',
          {
            grantId,
            secretSha256,
            generation: proxyIdentityFields.generation,
            hostFingerprint: proxyIdentityFields.hostFingerprint,
            buildSetId: proxyIdentityFields.buildSetId,
            proxyInstanceId: proxyIdentityFields.proxyInstanceId,
            operations: handoffOperations,
            orphanTimeoutMs: deadlineConfig.orphanTimeoutMs,
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        ),
      ]).then(([guardianAck, reaperAck, proxyAck]) => {
        handoffInstallAckSchema.parse(guardianAck);
        handoffInstallAckSchema.parse(reaperAck);
        handoffInstallAckSchema.parse(proxyAck);
      });
      signal.throwIfAborted();

      // The durable half. A grant installed with no capsule is a secret nobody could ever present, so this
      // is not reachable unless every install above already acknowledged the identical value.
      const capsule: HandoffCapsule = {
        version: 1,
        grantId,
        secret,
        generation: guardianIdentity.generation,
        flavor: guardianIdentity.flavor,
        buildSetId: guardianIdentity.buildSetId,
        hostFingerprint: guardianIdentity.hostFingerprint,
        guardianInstanceId: guardianIdentity.guardianInstanceId,
        reaperInstanceId: reaperIdentity.reaperInstanceId,
        proxyInstanceId: proxyIdentityFields.proxyInstanceId,
        guardianControlEndpoint: guardianIdentity.canonicalControlEndpoint,
        reaperControlEndpoint: reaperIdentity.canonicalControlEndpoint,
        proxyEndpoint: proxyIdentityFields.canonicalEndpoint,
        orphanTimeoutMs: deadlineConfig.orphanTimeoutMs,
        teardownReserveMs: deadlineConfig.teardownReserveMs,
      };
      writeHandoffCapsuleFile(handoffCapsulePath, capsule, {
        storage: runtime.storage,
        uid: process.getuid?.() ?? 0,
      });
    },
    stopAndReap: async (signal) => {
      try {
        // The coordinator's own half of the set-agreement both enforcers require exactly
        // (`assertRecordedSetAgreement`): every provider root this coordinator's own live operations still
        // hold against this proxy, from the same registry `snapshotOperations` above reads. An empty claim
        // disagrees with any enforcer that has actually staged a root — every activated operation stages one
        // before it is ever reported as executing — so this must name every one still live, not an empty set.
        const providerRoots = operationRegistry.providerRootsFor(proxyInstanceId);
        const raw = await raceAgainstAbort(
          guardianClient.call(
            'guardian.stop-and-reap.v1',
            { guardian: guardianIdentity, reaper: reaperIdentity, proxy: proxyIdentityFields, providerRoots },
            // `guardian.stop-and-reap.v1` is declared `budgetMs: 'caller-deadline'` on the server precisely
            // so it is not cut off there: a legitimate reap can spend the SIGTERM grace, the SIGKILL grace,
            // and the disappearance confirmation — an 11s floor inside `PROXY_TEARDOWN_RESERVE_MS`'s 14s,
            // and the SIGTERM grace alone already exceeds `PROXY_CONTROL_RPC_TIMEOUT_MS`. Budgeting this call
            // from the ordinary mutation-RPC timeout — the constant every other `client.call` in this file
            // correctly uses, because the server enforces that same value as its default for those methods —
            // would defeat the server's own carve-out and turn a legitimate hard reap into a guaranteed
            // `{ unconfirmed }`. `PROXY_TEARDOWN_RESERVE_MS` is that floor with margin, so it is the ceiling
            // here instead; the caller's own `signal` (raced below) is what actually bounds this in practice.
            PROXY_TEARDOWN_RESERVE_MS,
          ),
          signal,
        );
        return { disappearanceReceipt: stopAndReapResultSchema.parse(raw).disappearanceReceipt };
      } catch (error: unknown) {
        return { unconfirmed: error instanceof Error ? error.message : 'stop-and-reap did not confirm absence' };
      }
    },
    stopHeartbeats: () => {
      for (const heartbeat of heartbeats) heartbeat.stop();
    },
    initiateControlClose: async () => {
      proxyClient.close();
      guardianClient.close();
      reaperClient.close();
    },
  };
}

/**
 * The guardian's own acquisition-time undo: SIGTERM to the whole group, gated on the pid this acquisition
 * observed still being the process it spawned.
 *
 * The guardian is spawned `detached: true`, so it is its own process-group leader, and it in turn spawns the
 * reaper into that same group before the coordinator ever holds control on either — so this signals the whole
 * group via the negative-pid convention, not the guardian's own bare pid alone, or the reaper it already
 * spawned outlives it.
 *
 * SIGTERM here is what `role-main.ts`'s own shutdown handler treats as "give up": the guardian — and the
 * reaper right alongside it, since they share this one process group — drives its own enforcer's
 * `stopAndReap` on the detached, out-of-group proxy containment it holds before it exits, rather than merely
 * disarming and leaving that live leader held by no one. Whoever creates a thing holds it: the coordinator
 * created only the guardian, so its own undo can reach only the guardian's group directly, but asking the
 * guardian to give up is what makes it reap the reaper and proxy it created in turn, rather than the
 * coordinator having to reach across a boundary it has no standing to reach across itself.
 *
 * That reap can legitimately spend the same SIGTERM/SIGKILL grace and disappearance-confirmation budget any
 * other teardown does (`PROXY_TEARDOWN_RESERVE_MS`), so this waits that same floor for the group's own
 * disappearance before escalating to SIGKILL — a shorter fixed grace (`gracefulKillByPid`'s, built for a
 * plain child with nothing of its own left to do) would force-kill the guardian mid-reap and strand the very
 * containment it was just asked to hold.
 *
 * And a pid is not an identity on its own: the OS recycles it. This re-reads the pid's start time
 * immediately before signalling and refuses if it no longer matches what this acquisition recorded at spawn
 * time — signalling a mismatched pid would kill whatever unrelated process now holds it, which is the
 * project's BLOCKING process rule.
 */
export function buildGuardianSpawnUndo(
  runtime: Runtime,
  spawned: SpawnedRoleProcess,
  platform: NodeJS.Platform,
  readProcessStartedAtSeconds: (pid: number, platform: NodeJS.Platform) => number | null,
): () => Promise<void> {
  return async () => {
    if (readProcessStartedAtSeconds(spawned.pid, platform) !== spawned.processStartedAtSeconds) return;
    const group = -spawned.pid;
    runtime.process.kill(group, 'SIGTERM');
    const graceDeadline = runtime.time.now() + PROXY_TEARDOWN_RESERVE_MS;
    while (runtime.process.isAlive(group) && runtime.time.now() < graceDeadline) {
      await runtime.time.sleep(ABSENCE_POLL_MS);
    }
    if (runtime.process.isAlive(group)) {
      runtime.process.kill(group, 'SIGKILL');
    }
  };
}

export function createProviderProxyAcquisitionSteps(
  options: ProviderProxyAcquisitionStepsOptions,
): ProviderProxyAcquisitionSteps {
  const { runtime, coordinatorIdentity } = options;
  const { generation, flavor, buildSetId } = coordinatorIdentity;
  const hostFingerprint = options.hostFingerprint;
  const mintSecret = (): string => runtime.ids.randomBytes(32).toString('hex');

  let minted: MintedSet | null = null;
  let guardianSpawn: SpawnedRoleProcess | null = null;

  return {
    async createCapsules(): Promise<AcquisitionUndo> {
      const setIdentity = { generation, flavor, buildSetId, hostFingerprint };
      const guardianInstanceId = runtime.ids.uuid();
      const reaperInstanceId = runtime.ids.uuid();
      const proxyInstanceId = runtime.ids.uuid();
      const uid = process.getuid?.() ?? 0;

      const endpointEnv: ProviderProxyEndpointEnvironment = {
        ...(options.baseDir === undefined ? {} : { baseDir: options.baseDir }),
        platform: runtime.env.platform(),
        tempDirectory: runtime.env.tmpdir(),
        uid,
        storage: runtime.storage,
      };
      const guardianEndpoint = providerGuardianEndpoint({ ...setIdentity, guardianInstanceId }, endpointEnv);
      const reaperEndpoint = providerReaperEndpoint({ ...setIdentity, reaperInstanceId }, endpointEnv);
      const proxyEndpoint = providerProxyEndpoint({ ...setIdentity, proxyInstanceId }, endpointEnv);
      const capsulePathOptions = options.baseDir === undefined ? undefined : { baseDir: options.baseDir };
      const guardianCapsulePath = providerGuardianBootstrapCapsulePath(
        { ...setIdentity, guardianInstanceId },
        capsulePathOptions,
      );
      const reaperCapsulePath = providerReaperBootstrapCapsulePath(
        { ...setIdentity, reaperInstanceId },
        capsulePathOptions,
      );
      const proxyCapsulePath = providerProxyBootstrapCapsulePath(
        { ...setIdentity, proxyInstanceId },
        capsulePathOptions,
      );

      const next: MintedSet = {
        guardianInstanceId,
        reaperInstanceId,
        proxyInstanceId,
        guardianEndpoint,
        reaperEndpoint,
        proxyEndpoint,
        guardianCapsulePath,
        reaperCapsulePath,
        proxyCapsulePath,
        guardianBootstrapNonce: mintSecret(),
        reaperBootstrapNonce: mintSecret(),
        proxyBootstrapNonce: mintSecret(),
        // One shared secret per pairing channel — guardian<->reaper and proxy<->guardian are two distinct
        // trust relationships, so a leak of one must not also compromise the other.
        guardianReaperAuthSecret: mintSecret(),
        proxyGuardianAuthSecret: mintSecret(),
      };

      const capsuleEnv: Pick<ProviderBootstrapCapsuleEnvironment, 'storage' | 'uid'> = {
        storage: runtime.storage,
        uid,
      };
      // Every capsule in a set shares this same 7-field identity; only its own bootstrap nonce and endpoint
      // fields differ per role. Named once here, mirroring `bootstrap-capsule.ts`'s own
      // `commonBootstrapCapsuleShape` precedent for the identical shape at the schema level.
      const capsuleIdentityFields = { ...setIdentity, guardianInstanceId, reaperInstanceId, proxyInstanceId };
      const guardianCapsule: GuardianBootstrapCapsule = {
        role: 'guardian',
        ...capsuleIdentityFields,
        bootstrapNonce: next.guardianBootstrapNonce,
        canonicalControlEndpoint: guardianEndpoint,
        reaperControlEndpoint: reaperEndpoint,
        proxyEndpoint,
        guardianReaperAuthSecret: next.guardianReaperAuthSecret,
        proxyGuardianAuthSecret: next.proxyGuardianAuthSecret,
      };
      const reaperCapsule: ReaperBootstrapCapsule = {
        role: 'reaper',
        ...capsuleIdentityFields,
        bootstrapNonce: next.reaperBootstrapNonce,
        canonicalControlEndpoint: reaperEndpoint,
        guardianControlEndpoint: guardianEndpoint,
        proxyEndpoint,
        guardianReaperAuthSecret: next.guardianReaperAuthSecret,
      };
      const proxyCapsule: ProxyBootstrapCapsule = {
        role: 'proxy',
        ...capsuleIdentityFields,
        bootstrapNonce: next.proxyBootstrapNonce,
        canonicalEndpoint: proxyEndpoint,
        guardianControlEndpoint: guardianEndpoint,
        proxyGuardianAuthSecret: next.proxyGuardianAuthSecret,
      };

      createProviderBootstrapCapsule(guardianCapsulePath, guardianCapsule, capsuleEnv);
      createProviderBootstrapCapsule(reaperCapsulePath, reaperCapsule, capsuleEnv);
      createProviderBootstrapCapsule(proxyCapsulePath, proxyCapsule, capsuleEnv);

      minted = next;
      return {
        label: 'capsules',
        run: () => {
          // `force: true` tolerates a capsule already claimed by the process that consumed it — cleanup
          // after any later cut always reaches this point with at least the guardian's capsule already gone.
          runtime.storage.rmSync(guardianCapsulePath, { force: true });
          runtime.storage.rmSync(reaperCapsulePath, { force: true });
          runtime.storage.rmSync(proxyCapsulePath, { force: true });
        },
      };
    },

    async spawnGuardian(): Promise<AcquisitionUndo> {
      if (minted === null) {
        throw new Error('createCapsules must run before spawnGuardian.');
      }
      const setMinted = minted;
      const platform = runtime.env.platform() as NodeJS.Platform;
      const readProcessStartedAtSeconds = options.readProcessStartedAtSeconds ?? probeProcessStartedAtSeconds;
      const spawnPorts: RoleSpawnPorts = {
        process: runtime.process,
        time: runtime.time,
        platform,
        readProcessStartedAtSeconds,
      };
      const spawned = spawnRoleProcess('guardian', setMinted.guardianCapsulePath, spawnPorts, {
        pluginRoot: options.pluginRoot,
        detached: true,
        // The child strips all inherited CORAL_*, so the flavor that selects which artifact identity the
        // guardian (and, transitively, the reaper and proxy it spawns) expects is re-asserted explicitly.
        envAdditions: { [BUILD_FLAVOR_ENV_KEY]: flavor },
      });
      guardianSpawn = spawned;
      return {
        label: 'guardian',
        run: buildGuardianSpawnUndo(runtime, spawned, platform, readProcessStartedAtSeconds),
      };
    },

    async establishControl(): Promise<Readonly<{ set: ProviderProxyOperationAuthority; undo: AcquisitionUndo }>> {
      if (minted === null || guardianSpawn === null) {
        throw new Error('createCapsules and spawnGuardian must run before establishControl.');
      }
      const setMinted = minted;
      const spawnedGuardian = guardianSpawn;
      const timer = runtimeControlTimer(runtime);
      const retry: RoleConnectRetryOptions = {
        connectTimeoutMs: ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS,
        retryIntervalMs: ESTABLISH_CONTROL_RETRY_INTERVAL_MS,
        overallDeadlineMs: ESTABLISH_CONTROL_READY_DEADLINE_MS,
        now: () => runtime.time.now(),
        sleep: (ms: number) => runtime.time.sleep(ms),
      };
      const opened: ControlClient[] = [];

      try {
        // The proxy is reached first: only it can report its own pid, start time, and process-group id, and
        // both `guardian.open.v1` and `reaper.open.v1` need that identity as an input.
        const proxySession = await establishRoleControl(opened, timer, retry, {
          role: 'proxy',
          endpoint: setMinted.proxyEndpoint,
          openMethod: 'control.open.v1',
          openParams: { bootstrapNonce: setMinted.proxyBootstrapNonce, coordinator: coordinatorIdentity },
          openResultSchema: proxyOpenResultSchema,
          identity: (opened) => opened.proxy,
          heartbeatMethod: 'control.heartbeat.v1',
          expectedIdentity: {
            proxyInstanceId: setMinted.proxyInstanceId,
            guardianInstanceId: setMinted.guardianInstanceId,
            reaperInstanceId: setMinted.reaperInstanceId,
            generation,
            flavor,
            buildSetId,
            hostFingerprint,
            canonicalEndpoint: setMinted.proxyEndpoint,
          },
          ...(options.onProviderEvent === undefined ? {} : { onProviderEvent: options.onProviderEvent() }),
        });

        // The one identity this acquisition can verify in full: it spawned the guardian itself and observed
        // its pid and start time directly, rather than trusting a self-report with nothing to check it against.
        const guardianSession = await establishRoleControl(opened, timer, retry, {
          role: 'guardian',
          endpoint: setMinted.guardianEndpoint,
          openMethod: 'guardian.open.v1',
          openParams: {
            bootstrapNonce: setMinted.guardianBootstrapNonce,
            coordinator: coordinatorIdentity,
            proxy: proxySession.opened.proxy,
          },
          openResultSchema: guardianOpenResultSchema,
          identity: (opened) => opened.guardian,
          heartbeatMethod: 'guardian.heartbeat.v1',
          expectedIdentity: {
            guardianInstanceId: setMinted.guardianInstanceId,
            pid: spawnedGuardian.pid,
            processStartedAtSeconds: spawnedGuardian.processStartedAtSeconds,
            generation,
            flavor,
            buildSetId,
            hostFingerprint,
            canonicalControlEndpoint: setMinted.guardianEndpoint,
          },
        });

        const proxyIdentity = proxySession.opened.proxy;
        // Named from the proxy's own self-report, not re-derived: if this disagrees with what the guardian
        // recorded, `reaper.open.v1` itself refuses — the cross-check this acquisition needs for free, from
        // the one RPC built to make that exact disagreement visible.
        const reaperSession = await establishRoleControl(opened, timer, retry, {
          role: 'reaper',
          endpoint: setMinted.reaperEndpoint,
          openMethod: 'reaper.open.v1',
          openParams: {
            bootstrapNonce: setMinted.reaperBootstrapNonce,
            coordinator: coordinatorIdentity,
            guardian: guardianSession.opened.guardian,
            proxy: proxySession.opened.proxy,
            containment: {
              pid: proxyIdentity.pid,
              processStartedAtSeconds: proxyIdentity.processStartedAtSeconds,
              processGroupId: proxyIdentity.processGroupId,
              containmentKind: DETACHED_CONTAINMENT_KIND,
            },
          },
          openResultSchema: reaperOpenResultSchema,
          identity: (opened) => opened.reaper,
          heartbeatMethod: 'reaper.heartbeat.v1',
          expectedIdentity: {
            reaperInstanceId: setMinted.reaperInstanceId,
            guardianInstanceId: setMinted.guardianInstanceId,
            generation,
            flavor,
            buildSetId,
            hostFingerprint,
            canonicalControlEndpoint: setMinted.reaperEndpoint,
            containmentKind: DETACHED_CONTAINMENT_KIND,
          },
        });

        const heartbeats = [
          startHeartbeatLoop(
            proxySession.client,
            'control.heartbeat.v1',
            runtime,
            proxySession.opened.controlEpoch,
            proxySession.nextHeartbeatChallenge,
            () => {},
          ),
          startHeartbeatLoop(
            guardianSession.client,
            'guardian.heartbeat.v1',
            runtime,
            guardianSession.opened.controlEpoch,
            guardianSession.nextHeartbeatChallenge,
            () => {},
          ),
          startHeartbeatLoop(
            reaperSession.client,
            'reaper.heartbeat.v1',
            runtime,
            reaperSession.opened.controlEpoch,
            reaperSession.nextHeartbeatChallenge,
            () => {},
          ),
        ];

        const handoffCapsulePath = providerHandoffCapsulePath(
          { generation, flavor, buildSetId, hostFingerprint, proxyInstanceId: setMinted.proxyInstanceId },
          options.baseDir === undefined ? undefined : { baseDir: options.baseDir },
        );
        const base = createProviderProxySetAuthority({
          proxyInstanceId: setMinted.proxyInstanceId,
          guardianClient: guardianSession.client,
          proxyClient: proxySession.client,
          reaperClient: reaperSession.client,
          guardianIdentity: guardianSession.opened.guardian,
          reaperIdentity: reaperSession.opened.reaper,
          proxyIdentityFields: proxySession.opened.proxy,
          heartbeats,
          coordinatorIdentity,
          handoffCapsulePath,
          runtime,
          operationRegistry: options.operationRegistry,
        });
        // The set-level identity `operation.prepare.v1`'s coordinator meta commit needs (W2.3): fixed for
        // this set's whole lifetime, built from the exact same verified fields `base`'s identity checks just
        // confirmed rather than re-derived, so the two can never disagree.
        const setIdentity: ProviderProxySetIdentity = {
          buildSetId,
          hostFingerprint,
          guardianInstanceId: setMinted.guardianInstanceId,
          guardianPid: spawnedGuardian.pid,
          guardianProcessStartedAtSeconds: spawnedGuardian.processStartedAtSeconds,
          guardianControlEndpoint: setMinted.guardianEndpoint,
          proxyInstanceId: setMinted.proxyInstanceId,
          proxyPid: proxyIdentity.pid,
          reaperInstanceId: setMinted.reaperInstanceId,
          reaperPid: reaperSession.opened.reaper.pid,
          reaperProcessStartedAtSeconds: reaperSession.opened.reaper.processStartedAtSeconds,
          reaperControlEndpoint: setMinted.reaperEndpoint,
          containmentKind: DETACHED_CONTAINMENT_KIND,
          proxyProcessStartedAtSeconds: proxyIdentity.processStartedAtSeconds,
          proxyProcessGroupId: proxyIdentity.processGroupId,
          canonicalEndpoint: setMinted.proxyEndpoint,
        };
        const set = createProviderProxyOperationAuthority({
          base,
          setIdentity,
          proxyClient: proxySession.client,
          guardianClient: guardianSession.client,
          mutationRpcTimeoutMs: PROXY_OPERATION_ACTIVATION_RPC_TIMEOUT_MS,
        });

        return {
          set,
          undo: {
            label: 'control',
            run: () => {
              for (const heartbeat of heartbeats) heartbeat.stop();
              proxySession.client.close();
              guardianSession.client.close();
              reaperSession.client.close();
            },
          },
        };
      } catch (error: unknown) {
        for (const client of opened) client.close();
        throw error;
      }
    },
  };
}
