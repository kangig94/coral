import type { Runtime } from '../../../runtime/ports.js';
import type { CoordinatorIdentity as ProviderProxyCoordinatorIdentity } from '../../../provider-proxy/protocol.js';
import type { ProviderEventHandler } from '../../../provider-proxy/control-client.js';
import type { ProviderProxyOperationSnapshot } from '../../services/operation-registry.js';
import { acquireProviderProxySet, type ProviderProxyAcquisitionHeld } from '../provider-proxy/index.js';
import { createProviderProxyAcquisitionSteps } from '../provider-proxy/acquisition-steps.js';
import type { ProviderProxyOperationAuthority } from '../provider-proxy/operation-route.js';
import type { PublicationReceipt } from '../provider-proxy/set-publication.js';
import {
  closeProviderProxyAcquisitionSession,
  handOverProviderProxyAcquisitionControlSession,
  providerProxyControlSessionOwner,
  type ProviderProxyAcquisitionSessionHandedOver,
} from '../provider-proxy/control-session.js';
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
 * `incarnation` are this process's own observable state, read fresh from `runtime` at the moment
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
  /** Supplies the live provider roots used for stop-and-reap agreement. */
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
    /** Cancellation must not classify publication uncertainty as an ordinary failure. */
    signal: AbortSignal;
  }>;

export type ProviderProxySetAcquisitionOutcome =
  | Readonly<{
      kind: 'acquired';
      set: ProviderProxyOperationAuthority;
      publicationReceipt: PublicationReceipt;
    }>
  | Readonly<{ kind: 'failed'; reason: string; strandedArtifacts: readonly string[] }>
  | ProviderProxyAcquisitionHeld<'provider-host-manager'>
  | ProviderProxyAcquisitionSessionHandedOver<'provider-host-manager'>;

export type ProviderProxySetAcquisitionStopDisposition = 'contain' | 'handoff';

export async function disposeStoppedProviderProxySetAcquisition(
  outcome: ProviderProxySetAcquisitionOutcome,
  disposition: ProviderProxySetAcquisitionStopDisposition,
  signal?: AbortSignal,
): Promise<void> {
  if (outcome.kind === 'failed') return;
  if (outcome.kind === 'provider_proxy_acquisition_held') {
    const recovery = await outcome.recoveryCapability.retry(signal ?? new AbortController().signal);
    if (recovery.kind === 'held') throw new Error(`provider_proxy_set_acquisition_cleanup_held: ${recovery.reason}`);
    return;
  }
  if (outcome.kind === 'handed-over') {
    closeProviderProxyAcquisitionSession(
      outcome.session,
      disposition === 'contain' ? 'provider host manager stopped for shutdown' : 'provider host manager handed off',
    );
    if (disposition === 'contain') {
      throw new Error('provider_proxy_set_acquisition_containment_unconfirmed');
    }
    return;
  }
  if (disposition === 'contain') {
    const containment = await outcome.set.stopAndReap(signal ?? new AbortController().signal);
    if ('unconfirmed' in containment) {
      throw new Error(`provider_proxy_set_acquisition_containment_unconfirmed: ${containment.unconfirmed}`);
    }
    return;
  }

  const releases = [
    (() => {
      try {
        outcome.set.stopHeartbeats();
        return Promise.resolve();
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })(),
    (() => {
      try {
        return Promise.resolve(outcome.set.initiateControlClose());
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })(),
  ];
  const settled = await Promise.allSettled(releases);
  const failures = settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Provider proxy set acquisition handoff release failed.');
  }
}

/**
 * Starts one acquisition attempt for `entry`'s guardian/reaper/proxy set and reports how it settled.
 *
 * Never rejects before invoking `onSettled`: the caller of `acquireHostLease` gets its real app-server
 * session exactly as before, unaffected by whether this succeeds, fails, or is still running when that
 * session opens — a slow or failed acquisition here must add neither latency nor failure to it. Single-
 * flighting one attempt per entry is the caller's responsibility (mirrors `ensureProviderServerHandle` in
 * `recovery.ts`); this function always starts a fresh attempt when called.
 *
 * `env.signal` never converts a possibly published set into an ordinary failure; publication uncertainty
 * retains its recovery owner even when the signal has already aborted.
 */
export function ensureProviderProxySet(
  entry: ProviderHostEntry,
  env: ProviderProxySetAcquisitionEnvironment,
  onSettled: (outcome: ProviderProxySetAcquisitionOutcome) => void | Promise<void>,
): Promise<void> {
  const pid = env.runtime.env.pid();
  const platform = env.runtime.env.platform() as NodeJS.Platform;
  const incarnation = env.runtime.process.readProcessIncarnation(pid, platform);
  if (incarnation === null) {
    // This process's own incarnation is not a value this file may guess at: the coordinator identity it feeds
    // the handshake is a security-relevant field, not a diagnostic one, so an unreadable read is a failed
    // attempt rather than a fabricated `0`.
    return Promise.resolve(
      onSettled({
        kind: 'failed',
        reason: 'could not read this coordinator process’s own incarnation',
        strandedArtifacts: [],
      }),
    );
  }
  const coordinatorIdentity: ProviderProxyCoordinatorIdentity = {
    instanceId: env.identity.instanceId,
    pid,
    incarnation,
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
  return acquireProviderProxySet({
    steps,
    deadlineSignal: AbortSignal.any([AbortSignal.timeout(PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS), env.signal]),
  })
    .then(
      (result) => {
        if (result.kind === 'provider_proxy_acquisition_failed') {
          return onSettled({ kind: 'failed', reason: result.reason, strandedArtifacts: result.strandedArtifacts });
        }
        if (result.kind === 'provider_proxy_acquisition_held') {
          return onSettled({ ...result, owner: 'provider-host-manager' });
        }
        if (result.kind === 'handed-over') {
          return onSettled(
            handOverProviderProxyAcquisitionControlSession(
              result.session,
              providerProxyControlSessionOwner.providerHostManager,
              result.incident,
            ),
          );
        }
        return onSettled(result);
      },
      (error: unknown) => {
        return onSettled({
          kind: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          strandedArtifacts: [],
        });
      },
    )
    .then(() => undefined);
}
