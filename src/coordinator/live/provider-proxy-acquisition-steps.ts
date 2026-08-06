import { BUILD_FLAVOR_ENV_KEY } from '../../infra/build-flavor.js';
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
  type RoleSpawnPorts,
  type SpawnedRoleProcess,
} from '../../provider-proxy/role-spawn.js';
import { DETACHED_CONTAINMENT_KIND } from '../../provider-proxy/guardian.js';
import type { ControlClient } from '../../provider-proxy/control-client.js';
import {
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_CONTROL_HEARTBEAT_MS,
  PROXY_TEARDOWN_RESERVE_MS,
} from '../../provider-proxy/orphan-deadline.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS, type CoordinatorIdentity } from '../../provider-proxy/protocol.js';
import { gracefulKillByPid } from './process-supervision.js';
import type { AcquisitionUndo, ProviderProxyAcquisitionSteps } from './provider-proxy-acquisition.js';
import type { ProviderProxySetAuthority } from './provider-proxy-authority.js';

/**
 * The production implementation of `ProviderProxyAcquisitionSteps`: mints one guardian/reaper/proxy set's
 * identities and capsules, spawns the detached guardian, and establishes authenticated control on all three
 * endpoints. Each method depends on state the previous one produced — capsule paths on minted identities,
 * control on a spawned guardian — so calling them out of order (or `establishControl` before `spawnGuardian`
 * has run) is a caller defect, not a recoverable outcome; `acquireProviderProxySet` never does this.
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

async function heartbeatOnce(
  client: ControlClient,
  method: string,
  controlEpoch: number,
  heartbeatChallenge: string,
): Promise<{ nextHeartbeatChallenge: string }> {
  return (await client.call(method, { controlEpoch, heartbeatChallenge }, PROXY_CONTROL_RPC_TIMEOUT_MS)) as {
    nextHeartbeatChallenge: string;
  };
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
      const guardianCapsule: GuardianBootstrapCapsule = {
        role: 'guardian',
        generation,
        flavor,
        buildSetId,
        hostFingerprint,
        guardianInstanceId,
        reaperInstanceId,
        proxyInstanceId,
        bootstrapNonce: next.guardianBootstrapNonce,
        canonicalControlEndpoint: guardianEndpoint,
        reaperControlEndpoint: reaperEndpoint,
        proxyEndpoint,
        guardianReaperAuthSecret: next.guardianReaperAuthSecret,
        proxyGuardianAuthSecret: next.proxyGuardianAuthSecret,
      };
      const reaperCapsule: ReaperBootstrapCapsule = {
        role: 'reaper',
        generation,
        flavor,
        buildSetId,
        hostFingerprint,
        guardianInstanceId,
        reaperInstanceId,
        proxyInstanceId,
        bootstrapNonce: next.reaperBootstrapNonce,
        canonicalControlEndpoint: reaperEndpoint,
        guardianControlEndpoint: guardianEndpoint,
        proxyEndpoint,
        guardianReaperAuthSecret: next.guardianReaperAuthSecret,
      };
      const proxyCapsule: ProxyBootstrapCapsule = {
        role: 'proxy',
        generation,
        flavor,
        buildSetId,
        hostFingerprint,
        guardianInstanceId,
        reaperInstanceId,
        proxyInstanceId,
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
      const spawnPorts: RoleSpawnPorts = {
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        ...(options.readProcessStartedAtSeconds === undefined
          ? {}
          : { readProcessStartedAtSeconds: options.readProcessStartedAtSeconds }),
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
        run: () => gracefulKillByPid(runtime, spawned.pid),
      };
    },

    async establishControl(): Promise<Readonly<{ set: ProviderProxySetAuthority; undo: AcquisitionUndo }>> {
      if (minted === null || guardianSpawn === null) {
        throw new Error('createCapsules and spawnGuardian must run before establishControl.');
      }
      const setMinted = minted;
      const spawnedGuardian = guardianSpawn;
      const timer = runtimeControlTimer(runtime);
      const retry = {
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
        const proxyClient = await connectRoleControlWithRetry(setMinted.proxyEndpoint, timer, retry);
        opened.push(proxyClient);
        const proxyOpened = (await proxyClient.call(
          'control.open.v1',
          { bootstrapNonce: setMinted.proxyBootstrapNonce, coordinator: coordinatorIdentity },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        )) as { controlEpoch: number; heartbeatChallenge: string; proxy: Record<string, unknown> };
        assertIdentityFieldsAgree(
          'proxy',
          {
            proxyInstanceId: setMinted.proxyInstanceId,
            guardianInstanceId: setMinted.guardianInstanceId,
            reaperInstanceId: setMinted.reaperInstanceId,
            generation,
            flavor,
            buildSetId,
            hostFingerprint,
            canonicalEndpoint: setMinted.proxyEndpoint,
          },
          proxyOpened.proxy,
        );
        const proxyBeat = await heartbeatOnce(
          proxyClient,
          'control.heartbeat.v1',
          proxyOpened.controlEpoch,
          proxyOpened.heartbeatChallenge,
        );

        const guardianClient = await connectRoleControlWithRetry(setMinted.guardianEndpoint, timer, retry);
        opened.push(guardianClient);
        const guardianOpened = (await guardianClient.call(
          'guardian.open.v1',
          {
            bootstrapNonce: setMinted.guardianBootstrapNonce,
            coordinator: coordinatorIdentity,
            proxy: proxyOpened.proxy,
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        )) as {
          controlEpoch: number;
          heartbeatChallenge: string;
          guardian: Record<string, unknown>;
          proxy: Record<string, unknown>;
        };
        // The one identity this acquisition can verify in full: it spawned the guardian itself and observed
        // its pid and start time directly, rather than trusting a self-report with nothing to check it against.
        assertIdentityFieldsAgree(
          'guardian',
          {
            guardianInstanceId: setMinted.guardianInstanceId,
            pid: spawnedGuardian.pid,
            processStartedAtSeconds: spawnedGuardian.processStartedAtSeconds,
            generation,
            flavor,
            buildSetId,
            hostFingerprint,
            canonicalControlEndpoint: setMinted.guardianEndpoint,
          },
          guardianOpened.guardian,
        );
        const guardianBeat = await heartbeatOnce(
          guardianClient,
          'guardian.heartbeat.v1',
          guardianOpened.controlEpoch,
          guardianOpened.heartbeatChallenge,
        );

        const proxyIdentity = proxyOpened.proxy as {
          pid: number;
          processStartedAtSeconds: number;
          processGroupId: number;
        };
        const reaperClient = await connectRoleControlWithRetry(setMinted.reaperEndpoint, timer, retry);
        opened.push(reaperClient);
        const reaperOpened = (await reaperClient.call(
          'reaper.open.v1',
          {
            bootstrapNonce: setMinted.reaperBootstrapNonce,
            coordinator: coordinatorIdentity,
            guardian: guardianOpened.guardian,
            proxy: proxyOpened.proxy,
            // Named from the proxy's own self-report, not re-derived: if this disagrees with what the
            // guardian recorded, `reaper.open.v1` itself refuses — the cross-check this acquisition needs
            // for free, from the one RPC built to make that exact disagreement visible.
            containment: {
              pid: proxyIdentity.pid,
              processStartedAtSeconds: proxyIdentity.processStartedAtSeconds,
              processGroupId: proxyIdentity.processGroupId,
              containmentKind: DETACHED_CONTAINMENT_KIND,
            },
          },
          PROXY_CONTROL_RPC_TIMEOUT_MS,
        )) as { controlEpoch: number; heartbeatChallenge: string; reaper: Record<string, unknown> };
        assertIdentityFieldsAgree(
          'reaper',
          {
            reaperInstanceId: setMinted.reaperInstanceId,
            guardianInstanceId: setMinted.guardianInstanceId,
            generation,
            flavor,
            buildSetId,
            hostFingerprint,
            canonicalControlEndpoint: setMinted.reaperEndpoint,
            containmentKind: DETACHED_CONTAINMENT_KIND,
          },
          reaperOpened.reaper,
        );
        const reaperBeat = await heartbeatOnce(
          reaperClient,
          'reaper.heartbeat.v1',
          reaperOpened.controlEpoch,
          reaperOpened.heartbeatChallenge,
        );

        const heartbeats = [
          startHeartbeatLoop(
            proxyClient,
            'control.heartbeat.v1',
            runtime,
            proxyOpened.controlEpoch,
            proxyBeat.nextHeartbeatChallenge,
            () => {},
          ),
          startHeartbeatLoop(
            guardianClient,
            'guardian.heartbeat.v1',
            runtime,
            guardianOpened.controlEpoch,
            guardianBeat.nextHeartbeatChallenge,
            () => {},
          ),
          startHeartbeatLoop(
            reaperClient,
            'reaper.heartbeat.v1',
            runtime,
            reaperOpened.controlEpoch,
            reaperBeat.nextHeartbeatChallenge,
            () => {},
          ),
        ];

        const guardianIdentity = guardianOpened.guardian;
        const reaperIdentity = reaperOpened.reaper;
        const proxyIdentityFields = proxyOpened.proxy;

        const set: ProviderProxySetAuthority = {
          proxyInstanceId: setMinted.proxyInstanceId,
          // The proxy wire protocol has no operation-listing RPC yet — that lands with the operation
          // ledger's replay protocol (plan item W2.3). A set this acquisition just built has never had an
          // operation prepared on it, so empty is the accurate answer, not a placeholder.
          snapshotOperations: async () => [],
          installHandoffGrant: async (operationIds) => {
            if (operationIds.length > 0) {
              throw new Error(
                'Handoff grant installation for a non-empty operation set is wired by the operation ledger work (plan item W2.3).',
              );
            }
            const grantId = runtime.ids.uuid();
            const secret = mintSecret();
            const secretSha256 = runtime.ids.sha256(secret);
            await guardianClient.call(
              'guardian.handoff-install.v1',
              {
                grantId,
                secretSha256,
                successor: coordinatorIdentity,
                operations: [],
                orphanTimeoutMs: DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
                teardownReserveMs: PROXY_TEARDOWN_RESERVE_MS,
              },
              PROXY_CONTROL_RPC_TIMEOUT_MS,
            );
            await proxyClient.call(
              'handoff.install.v1',
              {
                grantId,
                secretSha256,
                generation,
                hostFingerprint,
                buildSetId,
                proxyInstanceId: setMinted.proxyInstanceId,
                operations: [],
                orphanTimeoutMs: DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
              },
              PROXY_CONTROL_RPC_TIMEOUT_MS,
            );
          },
          stopAndReap: async () => {
            try {
              const result = (await guardianClient.call(
                'guardian.stop-and-reap.v1',
                {
                  guardian: guardianIdentity,
                  reaper: reaperIdentity,
                  proxy: proxyIdentityFields,
                  providerRoots: [],
                },
                PROXY_CONTROL_RPC_TIMEOUT_MS,
              )) as { disappearanceReceipt: string };
              return { disappearanceReceipt: result.disappearanceReceipt };
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

        return {
          set,
          undo: {
            label: 'control',
            run: () => {
              for (const heartbeat of heartbeats) heartbeat.stop();
              proxyClient.close();
              guardianClient.close();
              reaperClient.close();
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
