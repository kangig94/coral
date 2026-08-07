import { probeProcessStartedAtSeconds } from '../../../infra/node-process.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { CoordinatorIdentity as ProviderProxyCoordinatorIdentity } from '../../../provider-proxy/protocol.js';
import { acquireProviderProxySet } from '../provider-proxy-acquisition.js';
import { createProviderProxyAcquisitionSteps } from '../provider-proxy-acquisition-steps.js';
import type { ProviderProxySetAuthority } from '../provider-proxy-authority.js';
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
}>;

export type ProviderProxySetAcquisitionEnvironment = ProviderProxySetAcquisitionConfig & Readonly<{ runtime: Runtime }>;

export type ProviderProxySetAcquisitionOutcome =
  | Readonly<{ kind: 'acquired'; set: ProviderProxySetAuthority }>
  | Readonly<{ kind: 'failed'; reason: string }>;

/**
 * Starts one acquisition attempt for `entry`'s guardian/reaper/proxy set and reports how it settled.
 *
 * Never rejects and is never awaited by its caller: nothing in production yet routes real provider work
 * through an acquired set — that lands with the operation-ledger wiring (plan item W2.3, a separate change)
 * — so a slow or failed acquisition here must add neither latency nor failure to the app-server session this
 * entry exists to serve. Single-flighting one attempt per entry is the caller's responsibility (mirrors
 * `ensureProviderServerHandle` in `recovery.ts`); this function always starts a fresh attempt when called.
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
  });
  void acquireProviderProxySet({
    steps,
    deadlineSignal: AbortSignal.timeout(PROVIDER_PROXY_SET_ACQUISITION_DEADLINE_MS),
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
