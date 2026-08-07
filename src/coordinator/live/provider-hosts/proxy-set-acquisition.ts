import { probeProcessStartedAtSeconds } from '../../../infra/node-process.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { CoordinatorIdentity as ProviderProxyCoordinatorIdentity } from '../../../provider-proxy/protocol.js';
import type { ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import type { ProviderProxyOperationSnapshot } from '../../services/operation-registry.js';
import { acquireProviderProxySet } from '../provider-proxy/index.js';
import { createProviderProxyAcquisitionSteps } from '../provider-proxy/acquisition-steps.js';
import type { ProviderProxyOperationAuthority } from '../provider-proxy/operation-route.js';
import { hostFingerprintFromSpec, type ProviderHostEntry } from './state.js';

/**
 * How long one guardian/reaper/proxy set acquisition — spawn, the three-role handshake, and its own cleanup
 * on failure — may run before this file gives up on it. `establishControl` connects the proxy, then the
 * guardian, then the reaper in sequence, each retrying up to its own 10s deadline
 * (`ESTABLISH_CONTROL_READY_DEADLINE_MS`), so a slow-but-legitimate real spawn can legitimately spend close
 * to three times that before this deadline is the honest read of "this attempt is not going to finish".
 */
const PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS = 45_000;

/**
 * The pieces of the coordinator's own protocol identity this file cannot derive on its own. `generation` is
 * the fixed protocol constant every set-identity path/schema in this codebase already hardcodes; `pid` and
 * `processStartedAtSeconds` are this process's own observable state, read fresh from `runtime` at the moment
 * of acquisition rather than threaded in, so a coordinator that has been running a while still reports itself
 * honestly.
 */
export type ProviderProxySetAcquisitionIdentity = Readonly<{
  instanceId: string;
  buildSetId: string;
  flavor: 'prod' | 'dev';
}>;

/** Everything one acquisition attempt needs beyond the entry itself, minus the runtime a caller already
 *  holds — the shape a coordinator composes once and a `ProviderHostManager` stores for the whole time it is
 *  configured to attempt acquisition at all. */
export type ProviderProxySetAcquisitionConfig = Readonly<{
  pluginRoot: string;
  identity: ProviderProxySetAcquisitionIdentity;
  /** This coordinator's own live operations, by proxy set — `installHandoffGrant`'s snapshot source
   *  (`ProviderProxySetAuthority.snapshotOperations`) — and the provider roots recorded against them,
   *  `stopAndReap`'s own half of the set-agreement both enforcers require. Already constructed at
   *  `composition/world.ts` time, unlike `onProviderEvent`, so it is threaded through directly rather than
   *  behind a factory. */
  operationRegistry: ProviderProxyOperationSnapshot;
  /**
   * Builds the durable-effect handler for `provider.event.v1` fresh, once per acquisition, rather than
   * accepting an already-built handler: this config is composed once, before the store exists
   * (`composition/world.ts` runs ahead of store open), while the handler itself needs the store. A factory
   * lets construction stay eager while evaluation stays lazy — it is only ever called once control is
   * actually established on the proxy role, by which point real provider work is already running and the
   * store is certainly open. Absent in every composition that does not wire proxy event application (every
   * test, and any coordinator build with W2.3 disabled) — the proxy connection is then opened with no
   * `onProviderEvent` handler installed at all, so a peer sending `provider.event.v1` over it gets the
   * protocol's own `protocol_violation` refusal instead of silence.
   */
  onProviderEvent?: () => ProviderEventHandler;
}>;

export type ProviderProxySetAcquisitionEnvironment = ProviderProxySetAcquisitionConfig &
  Readonly<{
    runtime: Runtime;
    /**
     * Aborted by the provider host manager's `stopAndClose` the instant it begins (see that field's own
     * doc), independent of and in addition to this attempt's own `PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS`
     * budget. Combined with it below via `AbortSignal.any`, so a stop mid-handshake reaches
     * `acquireProviderProxySet`'s own final gate the same way its internal timeout already does: unwound,
     * reported failed, and never published to the caller's `liveSets()` — whether or not the in-flight
     * handshake itself had a chance to notice the abort before finishing.
     */
    signal: AbortSignal;
  }>;

export type ProviderProxySetAcquisitionOutcome =
  | Readonly<{ kind: 'acquired'; set: ProviderProxyOperationAuthority }>
  | Readonly<{ kind: 'failed'; reason: string }>;

/**
 * Starts one acquisition attempt for `entry`'s guardian/reaper/proxy set and reports how it settled.
 *
 * Never rejects and is never awaited by its caller: the caller of `acquireHostLease` gets its real app-server
 * session exactly as before, unaffected by whether this succeeds, fails, or is still running when that
 * session opens — a slow or failed acquisition here must add neither latency nor failure to it. Single-
 * flighting one attempt per entry is the caller's responsibility (mirrors `ensureProviderServerHandle` in
 * `recovery.ts`); this function always starts a fresh attempt when called.
 *
 * `env.signal` lets a caller retract this attempt without waiting for it: aborting it never shortens an
 * in-flight handshake, but it guarantees the eventual outcome is `failed`, never `acquired` — see
 * `ProviderProxySetAcquisitionEnvironment.signal`'s own doc.
 */
export function ensureProviderProxySet(
  entry: ProviderHostEntry,
  env: ProviderProxySetAcquisitionEnvironment,
  onSettled: (outcome: ProviderProxySetAcquisitionOutcome) => void,
): void {
  const pid = env.runtime.env.pid();
  const platform = env.runtime.env.platform() as NodeJS.Platform;
  const processStartedAtSeconds = probeProcessStartedAtSeconds(pid, platform);
  if (processStartedAtSeconds === null) {
    // This process's own start time is not a value this file may guess at: the coordinator identity it feeds
    // the handshake is a security-relevant field, not a diagnostic one, so an unreadable read is a failed
    // attempt rather than a fabricated `0`.
    onSettled({ kind: 'failed', reason: 'could not read this coordinator process’s own start time' });
    return;
  }
  const coordinatorIdentity: ProviderProxyCoordinatorIdentity = {
    instanceId: env.identity.instanceId,
    pid,
    processStartedAtSeconds,
    generation: 'gen2',
    flavor: env.identity.flavor,
    buildSetId: env.identity.buildSetId,
  };
  const steps = createProviderProxyAcquisitionSteps({
    runtime: env.runtime,
    pluginRoot: env.pluginRoot,
    coordinatorIdentity,
    hostFingerprint: hostFingerprintFromSpec(entry.spec),
    operationRegistry: env.operationRegistry,
    ...(env.onProviderEvent === undefined ? {} : { onProviderEvent: env.onProviderEvent }),
  });
  void acquireProviderProxySet({
    steps,
    deadlineSignal: AbortSignal.any([AbortSignal.timeout(PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS), env.signal]),
  }).then(
    (result) => {
      onSettled(
        result.kind === 'acquired' ? { kind: 'acquired', set: result.set } : { kind: 'failed', reason: result.reason },
      );
    },
    (error: unknown) => {
      onSettled({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) });
    },
  );
}
