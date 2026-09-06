import { errorMessage } from '../../../infra/error-format.js';
import { createMonotonicClock } from '../../../infra/monotonic-clock.js';
import { reapRecordedContainment } from '../../../infra/process-containment.js';
import type { ProviderProxySetContainmentEvidence } from '../../../provider-proxy/containment-proof-contract.js';
import { MAX_PROXY_RECORDED_PROVIDER_ROOTS } from '../../../provider-proxy/enforcement.js';
import { providerProxyDisappearanceReceipt } from '../../../provider-proxy/protocol.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '../../../provider-proxy/orphan-deadline.js';
import type { Runtime } from '../../../runtime/ports.js';
import {
  providerProxySetContainmentEvidenceFor,
  releaseProviderProxySetContainmentProofFence,
  verifyProviderProxySetContainmentProofCurrent,
  type ProviderProxySetFencedContainmentProof,
} from './containment-proof.js';
import type { ProviderProxySetIdentity } from './identity.js';
import type { DurableProviderProxySetContainmentHoldOutcome } from './operator-disposition-store.js';

const providerSetDisappearanceClockScope = Symbol('provider-set-disappearance');

/** Signals the exact recorded containment with one stage of the bounded escalation. */
export type ProviderProxySetContainmentSignal = 'SIGTERM' | 'SIGKILL';

export type ProviderProxySetRecordedContainmentReapResult =
  | Readonly<{ kind: 'containment-absent'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'recorded-group-unattributable' }>
  | Readonly<{ kind: 'signal-authorization-refused' }>
  | Readonly<{ kind: 'identity-unobservable'; signalDelivered: boolean }>
  | Readonly<{ kind: 'authorization-missing' }>
  | Readonly<{ kind: 'authorization-stale' }>
  | Readonly<{ kind: 'store-unreadable' }>;

/** The caller retains the proof lease across this port and must release or transfer it from the result. */
export type ProviderProxySetRecordedContainmentReaper = (
  identity: ProviderProxySetIdentity,
  proof: ProviderProxySetFencedContainmentProof,
  signal: AbortSignal,
  onSignal: (signal: ProviderProxySetContainmentSignal) => void,
  assertSignalAuthorized?: () => void,
) => Promise<ProviderProxySetRecordedContainmentReapResult>;

export type DurableProviderProxySetContainmentReobservation =
  | Readonly<{ kind: 'retry'; reason: string }>
  | Readonly<{
      kind: 'retire';
      proof: ProviderProxySetFencedContainmentProof;
      disappearanceReceipt: string;
    }>
  | Readonly<{
      kind: 'publish-hold';
      evidence: Extract<ProviderProxySetContainmentEvidence, Readonly<{ kind: 'reap-required' }>>;
      reapOutcome: DurableProviderProxySetContainmentHoldOutcome;
    }>;

export async function reobserveDurableProviderProxySetContainment(
  options: Readonly<{
    identity: ProviderProxySetIdentity;
    proof: ProviderProxySetFencedContainmentProof;
    signal: AbortSignal;
    reapRecordedContainment: ProviderProxySetRecordedContainmentReaper;
  }>,
): Promise<DurableProviderProxySetContainmentReobservation> {
  const evidence = providerProxySetContainmentEvidenceFor(options.proof, options.identity);
  if (evidence.kind !== 'reap-required') {
    releaseProviderProxySetContainmentProofFence(options.proof);
    return { kind: 'retry', reason: `containment evidence was ${evidence.kind}` };
  }
  let transferred = false;
  try {
    const outcome = await options.reapRecordedContainment(
      options.identity,
      options.proof,
      options.signal,
      () => undefined,
    );
    if (outcome.kind === 'containment-absent') {
      transferred = true;
      return {
        kind: 'retire',
        proof: options.proof,
        disappearanceReceipt: outcome.disappearanceReceipt,
      };
    }
    return { kind: 'publish-hold', evidence, reapOutcome: outcome };
  } catch (error: unknown) {
    return { kind: 'retry', reason: JSON.stringify(errorMessage(error)).slice(1, -1) };
  } finally {
    if (!transferred) releaseProviderProxySetContainmentProofFence(options.proof);
  }
}

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
    if (outcome.kind !== 'containment-absent') return outcome;
    const currentness = verifyProviderProxySetContainmentProofCurrent(proof, identity);
    if (currentness.kind !== 'current') return currentness;
    return {
      kind: 'containment-absent',
      disappearanceReceipt: providerProxyDisappearanceReceipt(evidence.containment, evidence.recordedRoots),
    };
  };
}
