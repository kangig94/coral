import { errorMessage } from '../../../infra/error-format.js';
import type { ProviderProxySetContainmentEvidence } from '../../../provider-proxy/containment-proof-contract.js';
import type {
  GuardianSpawnUndoRecoverySubjectInput,
  ProviderProxyAcquisitionAbsenceEvidence,
} from '../../live/provider-proxy/spawn-undo.js';
import {
  providerProxySetContainmentEvidenceFor,
  releaseProviderProxySetContainmentProofFence,
  type ProviderProxySetFencedContainmentProof,
} from './containment-proof.js';
import type { ProviderProxySetIdentity } from './identity.js';
import type { DurableProviderProxySetContainmentHoldOutcome } from './operator-disposition-store.js';
import type { DurableProviderProxySetContainmentReobservation } from './recorded-containment-reaper.js';

export type DurableProviderProxySetReobservation =
  | Readonly<{ kind: 'retry'; reason: string }>
  | Readonly<{
      kind: 'retire';
      proof: ProviderProxySetFencedContainmentProof;
      disappearanceReceipt: string;
    }>
  | Readonly<{
      kind: 'publish-hold';
      evidence: ProviderProxySetContainmentEvidence;
      reapOutcome?: DurableProviderProxySetContainmentHoldOutcome;
    }>;

export type DurableProviderProxyAcquisitionReobservation =
  | Readonly<{ kind: 'retry'; reason: string }>
  | Readonly<{ kind: 'retire'; evidence: ProviderProxyAcquisitionAbsenceEvidence }>
  | Readonly<{ kind: 'publish-hold'; observation: 'alive' | 'unknown'; reason: string }>;

export type DurableOperatorDispositionReconciliationSettlement =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{ kind: 'retry'; reason: string }>;

function failureReason(error: unknown): string {
  return JSON.stringify(errorMessage(error)).slice(1, -1);
}

export async function reobserveDurableProviderProxySetDisposition(
  options: Readonly<{
    identity: ProviderProxySetIdentity;
    signal: AbortSignal;
    collectProof(
      identity: ProviderProxySetIdentity,
      signal: AbortSignal,
    ): Promise<ProviderProxySetFencedContainmentProof>;
    reobserveContainment(
      identity: ProviderProxySetIdentity,
      proof: ProviderProxySetFencedContainmentProof,
      signal: AbortSignal,
    ): Promise<DurableProviderProxySetContainmentReobservation>;
  }>,
): Promise<DurableProviderProxySetReobservation> {
  let proof: ProviderProxySetFencedContainmentProof;
  try {
    proof = await options.collectProof(options.identity, options.signal);
  } catch (error: unknown) {
    return { kind: 'retry', reason: failureReason(error) };
  }
  const evidence = providerProxySetContainmentEvidenceFor(proof, options.identity);
  if (evidence.kind !== 'reap-required') {
    releaseProviderProxySetContainmentProofFence(proof);
    return { kind: 'publish-hold', evidence };
  }
  return options.reobserveContainment(options.identity, proof, options.signal);
}

export async function reobserveDurableProviderProxyAcquisitionDisposition(
  options: Readonly<{
    subject: GuardianSpawnUndoRecoverySubjectInput;
    signal: AbortSignal;
    observe(
      subject: GuardianSpawnUndoRecoverySubjectInput,
      signal: AbortSignal,
    ): Promise<
      | Readonly<{ kind: 'containment-absent'; evidence: ProviderProxyAcquisitionAbsenceEvidence }>
      | Readonly<{ kind: 'held'; observation: 'alive' | 'unknown'; reason: string }>
    >;
  }>,
): Promise<DurableProviderProxyAcquisitionReobservation> {
  try {
    const outcome = await options.observe(options.subject, options.signal);
    return outcome.kind === 'containment-absent'
      ? { kind: 'retire', evidence: outcome.evidence }
      : { kind: 'publish-hold', observation: outcome.observation, reason: outcome.reason };
  } catch (error: unknown) {
    return { kind: 'retry', reason: failureReason(error) };
  }
}

export async function settleDurableOperatorDispositionReconciliation(
  run: () => Promise<void>,
): Promise<DurableOperatorDispositionReconciliationSettlement> {
  try {
    await run();
    return { kind: 'completed' };
  } catch (error: unknown) {
    return { kind: 'retry', reason: failureReason(error) };
  }
}
