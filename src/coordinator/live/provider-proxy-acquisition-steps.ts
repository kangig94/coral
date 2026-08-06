import { z } from 'zod';

import { BUILD_FLAVOR_ENV_KEY } from '../../infra/build-flavor.js';
import { probeProcessStartedAtSeconds } from '../../infra/node-process.js';
import {
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
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
  connectRoleControlWithRetry,
  runtimeControlTimer,
  spawnRoleProcess,
  type RoleConnectRetryOptions,
  type RoleSpawnPorts,
  type SpawnedRoleProcess,
} from '../../provider-proxy/role-spawn.js';
import { DETACHED_CONTAINMENT_KIND } from '../../provider-proxy/guardian.js';
import type { ControlClient } from '../../provider-proxy/control-client.js';
import { PROXY_CONTROL_HEARTBEAT_MS, PROXY_TEARDOWN_RESERVE_MS } from '../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
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

const ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS = 2_000;
const ESTABLISH_CONTROL_RETRY_INTERVAL_MS = 20;
const ESTABLISH_CONTROL_READY_DEADLINE_MS = 10_000;

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

/** Refused not-yet-implemented calls carry this so a caller can distinguish "this operation is not wired
 *  yet" from an ordinary RPC or identity failure. */
export class ProviderProxyHandoffGrantUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderProxyHandoffGrantUnavailableError';
    Object.setPrototypeOf(this, ProviderProxyHandoffGrantUnavailableError.prototype);
  }
}

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

async function heartbeatOnce(
  client: ControlClient,
  method: string,
  controlEpoch: number,
  heartbeatChallenge: string,
): Promise<{ nextHeartbeatChallenge: string }> {
  const raw = await client.call(method, { controlEpoch, heartbeatChallenge }, PROXY_CONTROL_RPC_TIMEOUT_MS);
  return heartbeatResultSchema.parse(raw);
}

type HeartbeatLoop = Readonly<{ stop(): void }>;

/** Keeps one established tenancy alive past its lease by echoing the challenge on the endpoint's own
 *  heartbeat interval. A failed echo is reported but not retried early — the enforcer's own deadline, not
 *  this loop, is what bounds the fallout of a tenancy that cannot be refreshed. */
function startHeartbeatLoop(
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

type ControlTimer = ReturnType<typeof runtimeControlTimer>;

/** One role's connect→open→verify→heartbeat plan. `identity` pulls the role's own identity field out of the
 *  already-schema-validated open result — a selector rather than a `result[role]` lookup, so the compiler
 *  checks it against the concrete open-result type instead of trusting a string key at runtime. */
type RoleControlPlan<TOpened extends { controlEpoch: number; heartbeatChallenge: string }> = Readonly<{
  role: string;
  endpoint: string;
  openMethod: string;
  openParams: Record<string, unknown>;
  openResultSchema: z.ZodType<TOpened>;
  identity: (opened: TOpened) => Record<string, unknown>;
  heartbeatMethod: string;
  expectedIdentity: Readonly<Record<string, string | number>>;
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
 */
async function establishRoleControl<TOpened extends { controlEpoch: number; heartbeatChallenge: string }>(
  opened: ControlClient[],
  timer: ControlTimer,
  retry: RoleConnectRetryOptions,
  plan: RoleControlPlan<TOpened>,
): Promise<Readonly<{ client: ControlClient; opened: TOpened; nextHeartbeatChallenge: string }>> {
  const client = await connectRoleControlWithRetry(plan.endpoint, timer, retry);
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
  } = deps;

  return {
    proxyInstanceId,
    // The proxy wire protocol has no operation-listing RPC yet — that lands with the operation ledger's
    // replay protocol (plan item W2.3). A set this acquisition just built has never had an operation
    // prepared on it, so empty is the accurate answer, not a placeholder.
    snapshotOperations: async () => [],
    installHandoffGrant: async () => {
      // The contract this implements promises a grant installed on guardian, reaper AND proxy, then a
      // written and fsynced successor capsule — a grant with no capsule is unredeemable, so half of that is
      // worse than none. Today this can only reach guardian and proxy (`reaper.handoff-install.v1` does not
      // exist) and writes no capsule at all, so it refuses outright rather than install a grant no successor
      // could ever find. Wiring both is the coordinated-shutdown / operation-ledger work (plan item W2.3).
      throw new ProviderProxyHandoffGrantUnavailableError(
        'installHandoffGrant refuses: the reaper has no install RPC (reaper.handoff-install.v1 does not ' +
          'exist) and no successor capsule is written, so a grant installed here would be unredeemable. ' +
          'Wiring both is the coordinated-shutdown / operation-ledger work (plan item W2.3).',
      );
    },
    stopAndReap: async (signal) => {
      try {
        const raw = await raceAgainstAbort(
          guardianClient.call(
            'guardian.stop-and-reap.v1',
            { guardian: guardianIdentity, reaper: reaperIdentity, proxy: proxyIdentityFields, providerRoots: [] },
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

/** How often `buildGuardianSpawnUndo` polls for the guardian's group to disappear before escalating.
 *  Matches `infra/process-containment.ts`'s own `ABSENCE_POLL_MS`. */
const GUARDIAN_GROUP_ABSENCE_POLL_MS = 25;

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
      await runtime.time.sleep(GUARDIAN_GROUP_ABSENCE_POLL_MS);
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

    async establishControl(): Promise<Readonly<{ set: ProviderProxySetAuthority; undo: AcquisitionUndo }>> {
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

        const set = createProviderProxySetAuthority({
          proxyInstanceId: setMinted.proxyInstanceId,
          guardianClient: guardianSession.client,
          proxyClient: proxySession.client,
          reaperClient: reaperSession.client,
          guardianIdentity: guardianSession.opened.guardian,
          reaperIdentity: reaperSession.opened.reaper,
          proxyIdentityFields: proxySession.opened.proxy,
          heartbeats,
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
