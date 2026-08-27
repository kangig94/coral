import { z } from 'zod';

import { BUILD_FLAVOR_ENV_KEY } from '../../../infra/build-flavor.js';
import { probeProcessIncarnation, type ProcessIncarnation } from '../../../infra/node-process.js';
import { PROVIDER_SERVER_INITIALIZE_TIMEOUT_MS } from '../../../providers/app-server-transport.js';
import {
  providerGuardianBootstrapCapsulePath,
  providerGuardianEndpoint,
  providerProxyBootstrapCapsulePath,
  providerProxyEndpoint,
  providerReaperBootstrapCapsulePath,
  providerReaperEndpoint,
  type ProviderProxyEndpointEnvironment,
} from '../../../infra/path/index.js';
import type { Runtime } from '../../../runtime/ports.js';
import {
  createProviderBootstrapCapsule,
  type GuardianBootstrapCapsule,
  type ProviderBootstrapCapsuleEnvironment,
  type ProxyBootstrapCapsule,
  type ReaperBootstrapCapsule,
} from '../../../provider-proxy/bootstrap-capsule.js';
import type { ProviderProxyOperationSnapshot } from '../../services/operation-registry.js';
import {
  runtimeControlTimer,
  spawnRoleProcess,
  type RoleConnectRetryOptions,
  type RoleSpawnPorts,
  type SpawnedRoleProcess,
} from '../../../provider-proxy/role-spawn.js';
import { currentHandoffCapsulePath } from '../../../provider-proxy/handoff-capsule.js';
import { DETACHED_CONTAINMENT_KIND } from '../../../provider-proxy/guardian.js';
import type { ControlClient, ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import {
  CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV,
  PROXY_CONTROL_ESTABLISH_READY_MS,
  resolveProviderProxyDeadlineConfiguration,
} from '../../../provider-proxy/orphan-deadline.js';
import {
  PROXY_CONTROL_RPC_TIMEOUT_MS,
  guardianIdentitySchema,
  proxyIdentitySchema,
  reaperIdentitySchema,
  type CoordinatorIdentity,
  controlEpochSchema,
  guardianOpenParamsSchema,
  heartbeatChallengeSchema,
  proxyControlOpenParamsSchema,
  reaperOpenParamsSchema,
} from '../../../provider-proxy/protocol.js';
import type { AcquisitionUndo, ProviderProxyAcquisitionSteps } from './index.js';
import { createProviderProxyAuthorityHeartbeatAssembly } from './heartbeat.js';
import { establishRoleControl } from './role-control.js';
import { createProviderProxySetAuthority } from './set-authority.js';
import { buildGuardianSpawnUndo } from './spawn-undo.js';
import { createProviderProxyOperationAuthority, type ProviderProxyOperationAuthority } from './operation-route.js';
import type { ProviderProxySetIdentity } from '../../services/provider-proxy-set/identity.js';
import { createProviderProxyAuthorityFaultLatch } from '../../services/provider-proxy-authority-fault.js';

/**
 * The production implementation of `ProviderProxyAcquisitionSteps`: mints one guardian/reaper/proxy set's
 * identities and capsules, spawns the detached guardian, and establishes authenticated control on all three
 * endpoints. Each method depends on state the previous one produced — capsule paths on minted identities,
 * control on a spawned guardian — so calling them out of order (or `establishControl` before `spawnGuardian`
 * has run) is a caller defect, not a recoverable outcome; `acquireProviderProxySet` never does this.
 *
 * Every RPC response is parsed with a strict schema before it is trusted — a peer's bytes are wire input like
 * any other, and a raw object cast here would forward unvalidated shapes straight into the next role's open
 * request (see `establishRoleControl`, `role-control.ts`) or report a malformed teardown as success (see
 * `createProviderProxySetAuthority`'s `stopAndReap`, `set-authority.ts`).
 */

// Exported for `services/provider-proxy-set/inheritance.ts`: redemption dials the same three role endpoints this
// file's own `establishControl` does, on the identical connect-retry budget, so a redeemed tenancy and a
// freshly spawned one time out the same way rather than silently drifting apart.
export const ESTABLISH_CONTROL_CONNECT_TIMEOUT_MS = 2_000;
export const ESTABLISH_CONTROL_RETRY_INTERVAL_MS = 20;
export const ESTABLISH_CONTROL_READY_DEADLINE_MS = PROXY_CONTROL_ESTABLISH_READY_MS;

// Prepare can consume a full app-server cold start plus guardian staging. A shorter caller deadline would turn
// an ordinary cold start into an ambiguous mutation and delay the reconciler until inspection or replay proves it.
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
  readProcessIncarnation?(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
  /** Supplies the live provider roots used for stop-and-reap agreement. */
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

export function createProviderProxyAcquisitionSteps(
  options: ProviderProxyAcquisitionStepsOptions,
): ProviderProxyAcquisitionSteps {
  const { runtime, coordinatorIdentity } = options;
  const { generation, flavor, buildSetId } = coordinatorIdentity;
  const hostFingerprint = options.hostFingerprint;
  const deadlineConfiguration = resolveProviderProxyDeadlineConfiguration(runtime.env);
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
      // Every capsule in a set shares this same identity; only its own bootstrap nonce and endpoint
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
      const readProcessIncarnation = options.readProcessIncarnation ?? probeProcessIncarnation;
      const spawnPorts: RoleSpawnPorts = {
        process: runtime.process,
        runtime,
        platform,
        readProcessIncarnation,
      };
      const spawned = spawnRoleProcess('guardian', setMinted.guardianCapsulePath, spawnPorts, {
        pluginRoot: options.pluginRoot,
        detached: true,
        envAdditions: {
          [BUILD_FLAVOR_ENV_KEY]: flavor,
          [CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV]: String(deadlineConfiguration.orphanTimeoutMs),
        },
      });
      guardianSpawn = spawned;
      return {
        label: 'guardian',
        run: buildGuardianSpawnUndo(runtime, spawned, platform, readProcessIncarnation),
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
      const faults = createProviderProxyAuthorityFaultLatch();
      const heartbeatAssembly = createProviderProxyAuthorityHeartbeatAssembly(runtime, faults);

      try {
        // The proxy is reached first: only it can report its own pid, incarnation, and process-group id, and
        // both `guardian.open.v1` and `reaper.open.v1` need that identity as an input.
        const proxySession = await establishRoleControl(opened, timer, retry, {
          role: 'proxy',
          endpoint: setMinted.proxyEndpoint,
          openMethod: 'control.open.v1',
          openParams: { bootstrapNonce: setMinted.proxyBootstrapNonce, coordinator: coordinatorIdentity },
          openParamsSchema: proxyControlOpenParamsSchema,
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
        heartbeatAssembly.startRole('proxy', {
          client: proxySession.client,
          controlEpoch: proxySession.opened.controlEpoch,
          nextHeartbeatChallenge: proxySession.nextHeartbeatChallenge,
          instanceId: setMinted.proxyInstanceId,
        });

        // The one identity this acquisition can verify in full: it spawned the guardian itself and observed
        // its pid and incarnation directly, rather than trusting a self-report with nothing to check it against.
        const guardianSession = await establishRoleControl(opened, timer, retry, {
          role: 'guardian',
          endpoint: setMinted.guardianEndpoint,
          openMethod: 'guardian.open.v1',
          openParams: {
            bootstrapNonce: setMinted.guardianBootstrapNonce,
            coordinator: coordinatorIdentity,
            proxy: proxySession.opened.proxy,
          },
          openParamsSchema: guardianOpenParamsSchema,
          openResultSchema: guardianOpenResultSchema,
          identity: (opened) => opened.guardian,
          heartbeatMethod: 'guardian.heartbeat.v1',
          expectedIdentity: {
            guardianInstanceId: setMinted.guardianInstanceId,
            pid: spawnedGuardian.pid,
            incarnation: spawnedGuardian.incarnation,
            generation,
            flavor,
            buildSetId,
            hostFingerprint,
            canonicalControlEndpoint: setMinted.guardianEndpoint,
          },
        });
        heartbeatAssembly.startRole('guardian', {
          client: guardianSession.client,
          controlEpoch: guardianSession.opened.controlEpoch,
          nextHeartbeatChallenge: guardianSession.nextHeartbeatChallenge,
          instanceId: setMinted.guardianInstanceId,
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
              incarnation: proxyIdentity.incarnation,
              processGroupId: proxyIdentity.processGroupId,
              containmentKind: DETACHED_CONTAINMENT_KIND,
            },
          },
          openParamsSchema: reaperOpenParamsSchema,
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
        heartbeatAssembly.startRole('reaper', {
          client: reaperSession.client,
          controlEpoch: reaperSession.opened.controlEpoch,
          nextHeartbeatChallenge: reaperSession.nextHeartbeatChallenge,
          instanceId: setMinted.reaperInstanceId,
        });

        const clients = {
          proxy: proxySession.client,
          guardian: guardianSession.client,
          reaper: reaperSession.client,
        };
        const heartbeats = heartbeatAssembly.complete();

        const handoffCapsulePath = currentHandoffCapsulePath(
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
        const installation = await base.installRecoveryCredential(new AbortController().signal);
        if (installation.kind !== 'installed') {
          throw new Error(`provider_proxy_recovery_credential_${installation.kind}`);
        }
        // The set-level identity `operation.prepare.v1`'s coordinator meta commit needs (W2.3): fixed for
        // this set's whole lifetime, built from the exact same verified fields `base`'s identity checks just
        // confirmed rather than re-derived, so the two can never disagree.
        const setIdentity: ProviderProxySetIdentity = {
          buildSetId,
          hostFingerprint,
          guardianInstanceId: setMinted.guardianInstanceId,
          guardianPid: spawnedGuardian.pid,
          guardianIncarnation: spawnedGuardian.incarnation,
          guardianControlEndpoint: setMinted.guardianEndpoint,
          proxyInstanceId: setMinted.proxyInstanceId,
          proxyPid: proxyIdentity.pid,
          reaperInstanceId: setMinted.reaperInstanceId,
          reaperPid: reaperSession.opened.reaper.pid,
          reaperIncarnation: reaperSession.opened.reaper.incarnation,
          reaperControlEndpoint: setMinted.reaperEndpoint,
          containmentKind: DETACHED_CONTAINMENT_KIND,
          proxyIncarnation: proxyIdentity.incarnation,
          proxyProcessGroupId: proxyIdentity.processGroupId,
          canonicalEndpoint: setMinted.proxyEndpoint,
        };
        const set = createProviderProxyOperationAuthority({
          base,
          setIdentity,
          clients,
          faults,
          mutationRpcTimeoutMs: PROXY_OPERATION_ACTIVATION_RPC_TIMEOUT_MS,
        });
        return {
          set,
          undo: {
            label: 'control',
            run: () => {
              heartbeats.proxy.stop();
              heartbeats.guardian.stop();
              heartbeats.reaper.stop();
              proxySession.client.close();
              guardianSession.client.close();
              reaperSession.client.close();
            },
          },
        };
      } catch (error: unknown) {
        heartbeatAssembly.stop();
        for (const client of opened) client.close();
        throw error;
      }
    },
  };
}
