import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import { reapRecordedContainment } from '../../../infra/process-containment.js';
import {
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  providerProxyDisappearanceReceipt,
} from '../../../provider-proxy/enforcement.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import type { Runtime } from '../../../runtime/ports.js';
import { providerProxySetContainmentEvidenceFor, type ProviderProxySetContainmentProof } from './containment-proof.js';
import type { ProviderProxySetIdentity } from './identity.js';

const providerSetDisappearanceClockScope = Symbol('provider-set-disappearance');

/** Signals the exact recorded containment with one stage of the bounded escalation. */
export type ProviderProxySetContainmentSignal = 'SIGTERM' | 'SIGKILL';

/** The only terminal observations produced by exact recorded-containment reaping. */
export type ProviderProxySetRecordedContainmentReapResult =
  | Readonly<{ kind: 'containment-absent'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'recorded-group-unattributable' }>;

/** Destructive owner port that accepts only an identity-bound opaque containment proof. */
export type ProviderProxySetRecordedContainmentReaper = (
  identity: ProviderProxySetIdentity,
  proof: ProviderProxySetContainmentProof,
  signal: AbortSignal,
  onSignal: (signal: ProviderProxySetContainmentSignal) => void,
  assertSignalAuthorized?: () => void,
) => Promise<ProviderProxySetRecordedContainmentReapResult>;

/** Builds the only reaper that can turn an identity-bound proof into recorded-target signal authority. */
export function createProviderProxySetRecordedContainmentReaper(
  runtime: Runtime,
): ProviderProxySetRecordedContainmentReaper {
  return async (identity, proof, signal, onSignal, assertSignalAuthorized) => {
    const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
    if (evidence.kind !== 'reap-required') {
      throw new Error('provider_proxy_set_containment_reap_proof_not_reap_required');
    }
    const clock = createMonotonicClock(providerSetDisappearanceClockScope);
    const outcome = await reapRecordedContainment(
      evidence.containment,
      evidence.recordedRoots,
      clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS),
      {
        maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
        clock,
        process: runtime.process,
        platform: runtime.env.platform() as NodeJS.Platform,
        readProcessIncarnation: (pid, platform) => runtime.process.readProcessIncarnation(pid, platform),
        signal,
        assertSignalAuthorized,
        onSignal: ({ signal: delivered }) => {
          if (delivered === 'SIGTERM' || delivered === 'SIGKILL') onSignal(delivered);
        },
      },
    );
    signal.throwIfAborted();
    return outcome.kind === 'containment-absent'
      ? {
          kind: 'containment-absent',
          disappearanceReceipt: providerProxyDisappearanceReceipt(evidence.containment, evidence.recordedRoots),
        }
      : outcome;
  };
}
