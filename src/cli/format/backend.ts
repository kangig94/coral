import { assertNever } from '../../infra/error-format.js';
import type { HandoffRoutingBasis } from '../../coordinator/handoff-routing/policy.js';
import {
  HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY,
  type HandoffRoutingInvocationStatus,
  type HandoffRoutingResolveResult,
  type HandoffRoutingStatusReadResult,
  type OwnerLiveness,
  type RetirementHistoryTruncated,
  type SelectedHandoffDisposition,
  type StoredTerminalDisposition,
} from '../../coordinator/handoff-routing/status.js';
import {
  liveHandoffResultObligation,
  type HandoffContinuationReason,
  type HandoffStartupObservationAborted,
  type LiveHandoffResult,
} from '../../coordinator/handoff-routing/runner.js';
import { encodeRecoveryQuarantineKey, type RecoveryQuarantineListEntry } from '../../recovery/quarantine.js';
import type { BackendHealth } from '../../transport/http/backend/health.js';
import type { BackendStatusFull } from '../../transport/http/backend/status.js';
import type { OperatorFacingCoralSetupError } from '../../runtime/errors.js';
import type { ShutdownResult } from '../../transport/http/backend/shutdown.js';
import {
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryQuarantineClearResult,
} from '../../recovery/source-registry.js';
import { encodeProviderProxySetAddress } from '../../provider-proxy/set-address.js';
import type { ProviderProxySetContainResponse } from '../../transport/rpc/catalog.js';
import type { UnreadableProviderOperationDiscardResult } from '../../recovery/unreadable-provider-operation.js';
import type { ProviderProxySetLifecycleState } from '../../provider-proxy/set-lifecycle-state-vocabulary.js';
import { isProviderOperationRecordKey } from '../../store/provider-operation-journal.js';
import { formatHandoffPublicationFailureSuccessor } from './handoff-publication.js';

export const RECOVERY_REVISION_UNTIL_CLEARED = 'until-cleared';
export const RECOVERY_REVISION_FINGERPRINT_PREFIX = 'fingerprint:';

function formatProviderProxySetClaimDischarge(
  discharge: Extract<
    ProviderProxySetContainResponse,
    { kind: 'contained' | 'abandoned' | 'unattributable-group-abandoned' }
  >['claimDischarge'],
): string {
  switch (discharge.kind) {
    case 'completed':
      return 'Every durable claim was accepted by its successor and the set representation was released.';
    case 'initial-disposition-retry-owned':
      return 'Claim discharge has not reached an initial disposition; Coral still owns retry and still represents the set.';
    case 'operational-retry-owned':
      return `Claim discharge is retry-owned for ${discharge.incidents.length} incident(s); Coral still represents the set until every successor accepts and capsule retirement completes.`;
    default:
      return assertNever(discharge);
  }
}

export function formatProviderProxySetContainResult(result: ProviderProxySetContainResponse): string {
  const token = encodeProviderProxySetAddress(result.setIdentity);
  const retry = `coral-cli backend provider-proxy-set contain ${token}`;
  const observations = (values: ReadonlyArray<{ role: string; observation: string }>): string =>
    values.map(({ role, observation }) => `${role}=${observation}`).join(', ');
  const effect = [
    result.effect.signalsSent.length === 0
      ? 'no process signal was sent'
      : `${result.effect.signalsSent.join(' then ')} was sent to observed-live recorded proxy-group or provider-root targets`,
    result.effect.containmentAbsent
      ? 'the recorded containment was confirmed absent'
      : 'recorded-containment absence was not confirmed',
    result.effect.representationAction === 'none'
      ? 'Coral did not start representation release'
      : result.effect.representationAction === 'absence-release-started'
        ? 'Coral started evidence-backed representation release'
        : 'Coral started operator-abandonment representation release',
  ].join('; ');
  switch (result.kind) {
    case 'contained':
      return [
        `Provider proxy set ${token} was contained.`,
        'Observed: guardian=absent, reaper=absent, and the recorded proxy process group plus every recorded provider root are absent.',
        "Not observed: processes outside this set's recorded proxy group and provider-root records.",
        `Effect: ${effect}.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'Next step: run coral-cli backend status.',
      ].join('\n');
    case 'abandoned':
      return [
        `Provider proxy set ${token} was abandoned without absence proof.`,
        `Observed: ${observations(result.enforcerObservations)}.`,
        'Not observed: absence of the proxy process group and recorded provider roots; guardian and reaper were not signalled.',
        `Effect: ${effect}.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'Next step: run coral-cli backend status and verify the proxy, guardian, reaper, and provider processes externally.',
      ].join('\n');
    case 'unattributable-group-abandoned':
      return [
        `Provider proxy set ${token} was abandoned after its recorded process group became unattributable.`,
        'Observed: the recorded leader identity is gone.',
        'Not observed: absence of the process group or proof that its numeric group id still belongs to this set.',
        `Effect: ${effect}.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'Next step: run coral-cli backend status and verify the proxy and provider processes externally.',
      ].join('\n');
    case 'set-not-found':
      return [
        `Provider proxy set ${token} is not represented by this coordinator.`,
        'Observed: the exact set address has no coordinator representation.',
        'Not observed: enforcer state or recorded-target state.',
        `Effect: ${effect}.`,
        'Next step: run coral-cli backend status and copy the current exact token.',
      ].join('\n');
    case 'not-held':
      return [
        `Refusing forced containment for ${token}: the set is ${result.state}, not an operator-exit hold.`,
        `Observed: coordinator lifecycle state=${result.state}.`,
        'Not observed: enforcer state or recorded-target state.',
        `Effect: ${effect}.`,
        `Next step: ${providerProxySetNotHeldNextStep(result.state)}.`,
      ].join('\n');
    case 'deadline-pending':
      return [
        `Refusing forced containment for ${token}: its monotonic operator-exit gate has ${Math.ceil(result.remainingMs)}ms remaining.`,
        `Observed: the exact set remains held before its state-specific gate.`,
        'Not observed: enforcer state or recorded-target state.',
        `Effect: ${effect}.`,
        `Next step: wait for the gate, then run ${retry}.`,
      ].join('\n');
    case 'authorization-stale':
      return [
        `The operator-exit authorization for ${token} became stale.`,
        result.effect.containmentAbsent
          ? 'Observed: the recorded containment reached confirmed absence before the attempt changed.'
          : 'Observed: the held attempt changed before containment absence was confirmed.',
        "Not observed: the current held attempt's enforcer and recorded-target state.",
        `Effect: ${effect}.`,
        `Next step: run coral-cli backend status, then run ${retry} only if the same set remains held.`,
      ].join('\n');
    case 'enforcer-alive':
      return [
        `Refusing to signal ${token}: an enforcer was observed alive.`,
        `Observed: ${observations(result.enforcerObservations)}.`,
        'Not observed: absence of the proxy process group and recorded provider roots.',
        `Effect: ${effect}.`,
        `Next step: after external verification, run ${retry} --abandon-without-absence.`,
      ].join('\n');
    case 'enforcer-unobservable':
      return [
        `No containment verdict for ${token}: an enforcer was unobservable.`,
        `Observed: ${observations(result.enforcerObservations)}.`,
        'Not observed: absence of both enforcers or of the recorded containment.',
        `Effect: ${effect}.`,
        `Next step: restore process observation and run ${retry}; after external verification, the explicit alternative is ${retry} --abandon-without-absence.`,
      ].join('\n');
    case 'recorded-group-unattributable':
      return [
        `No containment verdict for ${token}: the recorded leader identity is gone, and the process group is alive or unobservable but cannot be proven to belong to this set.`,
        'Observed: the pid no longer identifies the recorded process-group leader.',
        'Not observed: absence of the recorded process group or authority to signal its numeric group id.',
        `Effect: ${effect}.`,
        `Next step: after external verification, run ${retry} --abandon-without-absence; abandonment releases Coral's representation without asserting absence or signalling the group.`,
      ].join('\n');
    case 'store-unreadable':
      return [
        `Refusing forced containment for ${token}: an unreadable durable provider-operation row may hide a provider root.`,
        'Observed: the durable provider-operation scan contains an unreadable row attributable to this set.',
        'Not observed: enforcer state and the complete recorded target set were not established.',
        `Effect: ${effect}. --abandon-without-absence cannot override this store fence.`,
        'Next step: run coral-cli backend recovery-quarantine list, then run coral-cli backend recovery-quarantine discard-provider-operation with the exact printed key and revision if losing that raw operation record is acceptable.',
      ].join('\n');
    default:
      return assertNever(result);
  }
}

function providerProxySetNotHeldNextStep(state: ProviderProxySetLifecycleState): string {
  switch (state) {
    case 'available':
    case 'draining':
      return 'run coral-cli backend shutdown to use ordinary drain, or run coral-cli backend status without forcing this set';
    case 'acquiring':
      return 'let acquisition finish, then run coral-cli backend status';
    case 'capsule-recovering':
    case 'recovering':
      return 'let recovery finish, then run coral-cli backend status';
    case 'absence-delivery-pending':
    case 'abandonment-delivery-pending':
      return 'let successor delivery finish, then run coral-cli backend status';
    case 'capsule-foreign':
      return 'run coral-cli backend status and use the Coral build that owns the foreign capsule';
    case 'reattaching':
    case 'containing':
    case 'containment-wait':
      return 'run coral-cli backend status, copy its current exact token, and retry only after the reported gate';
    default:
      return assertNever(state);
  }
}

function formatLiveHandoffResult(result: LiveHandoffResult | null): string | null {
  return result === null ? null : formatHandoffContinuationReason(result.continuation.reason);
}

export function formatHandoffContinuationReason(reason: HandoffContinuationReason): string {
  switch (reason.kind) {
    case 'routing':
      return formatHandoffRoutingBasis(reason.basis);
    case 'handoff-not-applicable':
      return 'Handoff: not applicable — this is a display-only invocation.';
    case 'handoff-abandoned':
      return [
        'Handoff: continuing current build — delegation was abandoned because stdout did not finish draining.',
        "Next step: retry; if stdout still does not drain, preserve the output and inspect the invoking process's stdout consumer.",
      ].join('\n');
    default:
      return assertNever(reason);
  }
}

export function formatHandoffRoutingBasis(basis: HandoffRoutingBasis): string {
  switch (basis.kind) {
    case 'incumbent-absent':
      return 'Handoff: continuing current build — no incumbent coordinator was observed.';
    case 'incumbent-unresolved':
      return [
        `Handoff: continuing current build — the incumbent coordinator could not be resolved because ${formatUnresolvedIncumbentCause(basis.cause)}.`,
        basis.cause === 'health-shape-rejected'
          ? 'Next step: run coral-cli backend shutdown, then run any coral-cli mutating command (or start a Claude Code session); it attempts startup or handoff from the current installation.'
          : 'Next step: follow the daemon-status remediation above; do not proceed while coral-cli backend status exits 75.',
      ].join('\n');
    case 'incumbent-unusable':
      return formatUnusableIncumbent(basis);
    case 'invoking-identity-unavailable':
      return [
        `Handoff: continuing current build — ${formatInvokingIdentityFailure(basis.failure)}.`,
        'Next step: repair or reinstall this Coral bundle, then retry.',
      ].join('\n');
    case 'incumbent-identity-unavailable':
      return [
        `Handoff: continuing current build — incumbent ${basis.incumbent.version} did not report a complete bundle identity.`,
        'Next step: run coral-cli backend shutdown, then rerun a mutating command; it attempts startup or handoff from this installation.',
      ].join('\n');
    case 'same-build-set':
      return `Handoff: continuing current build — invoking and incumbent builds share build set ${basis.buildSetId}.`;
    case 'invoking-build-not-older':
      return formatInvokingBuildNotOlder(basis);
    case 'invalid-incumbent-target':
      return formatInvalidIncumbentTarget(basis);
    default:
      return assertNever(basis);
  }
}

function formatInvokingBuildNotOlder(
  basis: Extract<HandoffRoutingBasis, { kind: 'invoking-build-not-older' }>,
): string {
  const nextStep =
    'Next step: run coral-cli backend shutdown, then rerun a mutating command; it attempts startup or handoff from this installation.';
  switch (basis.comparison) {
    case 'same-version':
      return [
        `Handoff: continuing current build — the CLI and running backend are both version ${basis.invoking.version} but come from different builds, so guarded operations will not proceed.`,
        nextStep,
      ].join('\n');
    case 'newer-version':
      // See routeOrOpenBackendStoreAtStartup in src/store/startup-store-routing.ts.
      return [
        `Handoff: continuing current build — invoking build ${basis.invoking.version} is newer than incumbent ${basis.incumbent.version}.`,
        nextStep,
      ].join('\n');
    default:
      return assertNever(basis.comparison);
  }
}

function formatUnresolvedIncumbentCause(
  cause: Extract<HandoffRoutingBasis, { kind: 'incumbent-unresolved' }>['cause'],
): string {
  switch (cause) {
    case 'unreadable-record':
      return 'its coordinator record could not be read';
    case 'health-request-failed':
      return 'its authenticated health request did not complete';
    case 'health-shape-rejected':
      return 'its authenticated health reply was not recognized';
    default:
      return assertNever(cause);
  }
}

function formatUnusableIncumbent(basis: Extract<HandoffRoutingBasis, { kind: 'incumbent-unusable' }>): string {
  switch (basis.cause) {
    case 'draining':
      return [
        'Handoff: continuing current build — the incumbent coordinator is shutting down.',
        'Next step: wait for backend shutdown to finish, then retry.',
      ].join('\n');
    case 'identity-mismatch':
      return [
        'Handoff: continuing current build — the authenticated coordinator identity does not match its discovery record.',
        'Next step: run coral-cli backend shutdown, wait for shutdown to finish, then retry.',
      ].join('\n');
    default:
      return assertNever(basis.cause);
  }
}

function formatInvokingIdentityFailure(
  failure: Extract<HandoffRoutingBasis, { kind: 'invoking-identity-unavailable' }>['failure'],
): string {
  switch (failure) {
    case 'embedded_identity_unavailable':
      return 'this CLI has no embedded build identity';
    case 'adjacent_manifest_unavailable':
      return "this CLI's bundle manifest could not be read";
    case 'adjacent_manifest_invalid':
      return "this CLI's bundle manifest is invalid";
    case 'adjacent_manifest_mismatch':
      return 'this CLI does not match its bundle manifest';
    default:
      return assertNever(failure);
  }
}

function formatInvalidIncumbentTarget(
  basis: Extract<HandoffRoutingBasis, { kind: 'invalid-incumbent-target' }>,
): string {
  const incumbent =
    basis.evidence.expectedManifest === null ? 'the incumbent' : `incumbent ${basis.evidence.expectedManifest.version}`;
  return [
    `Handoff: continuing current build — ${incumbent} handoff target at ${basis.evidence.bundleDir} is invalid because ${formatInvalidTargetFailure(basis.evidence.failure)}.`,
    `Next step: repair or reinstall the Coral installation at ${basis.evidence.bundleDir}, then retry.`,
  ].join('\n');
}

function formatInvalidTargetFailure(
  failure: Extract<HandoffRoutingBasis, { kind: 'invalid-incumbent-target' }>['evidence']['failure'],
): string {
  switch (failure) {
    case 'bundle-dir-not-canonical':
      return 'its bundle directory is not canonical';
    case 'bundle-dir-unavailable':
      return 'its bundle directory is unavailable';
    case 'expected-manifest-invalid':
      return 'its reported bundle manifest is invalid';
    case 'adjacent-manifest-unavailable':
      return 'its bundle manifest could not be read';
    case 'adjacent-manifest-invalid':
      return 'its bundle manifest is invalid';
    case 'adjacent-manifest-mismatch':
      return 'its bundle manifest does not match the expected build';
    case 'adjacent-bundle-mismatch':
      return 'its executable bundle does not match its manifest';
    default:
      return assertNever(failure);
  }
}

// Shared by every shutdown disposition this run could not resolve either way: none of them may tell an
// operator to do anything but ask again.
const SHUTDOWN_RETRY_NEXT_STEP = 'Next step: run coral-cli backend status, then retry the shutdown.';
const SHUTDOWN_UNPUBLISHED_COORDINATOR_NEXT_STEP =
  'Next step: retry shortly in case a coordinator is still publishing its discovery record. If this persists, verify that no other Coral coordinator process is running before treating the backend as stopped.';

export function formatBackendStatus(
  daemonStatus: BackendStatusFull,
  routingStatus: HandoffRoutingStatusReadResult,
  liveHandoffResult: LiveHandoffResult | null,
): string {
  const sections = [formatDaemonStatus(daemonStatus)];
  const routingStatusText = formatHandoffRoutingStatus(routingStatus);
  if (routingStatusText !== null) sections.push(routingStatusText);
  if (liveHandoffResultObligation(liveHandoffResult).severity === 'warning') {
    const liveHandoffText = formatLiveHandoffResult(liveHandoffResult);
    if (liveHandoffText !== null) sections.push(liveHandoffText);
  }
  return sections.join('\n');
}

function formatDaemonStatus(result: BackendStatusFull): string {
  switch (result.status) {
    case 'ok':
      return formatRunningStatus(result.health);
    case 'no_record_no_socket':
      return 'No coordinator discovery record and no coordinator socket at the current expected address were found. Any coral-cli mutating command (or a Claude Code session start) attempts startup.';
    case 'recorded_process_absent':
      return `A coordinator discovery record names pid=${result.pid}, and that process was observed absent. The record may be stale while another coordinator holds the socket without having published its own record. Any coral-cli mutating command (or a Claude Code session start) attempts startup or handoff.`;
    case 'foreign_coordinator':
      return `The recorded coordinator address is held by a coordinator for namespace=${result.observed.namespace} flavor=${result.observed.flavor}, not this one. Startup stays held until that conflict is resolved: stop that coordinator through the service or account that owns it, or run this build's own coral-cli backend shutdown.`;
    case 'undecodable_record':
      return formatUndecodableRecordStatus(result);
    case 'unreachable':
      return formatUnreachableStatus(result);
    case 'no_record_socket_present':
      return formatNoRecordSocketPresentStatus(result);
    case 'recent_failure':
      return formatRecentFailureStatus(result);
    case 'shutting_down':
      return 'Backend shutting down';
    case 'unauthorized':
      return 'Backend unauthorized. The discovery record and daemon token disagree — run coral-cli backend shutdown, then retry a coral-cli mutating command; it attempts startup or handoff with a fresh token.';
    default:
      return assertNever(result);
  }
}

function formatSelectedRoutingBasis(
  basis: Extract<SelectedHandoffDisposition, { kind: 'continue-current' }>['basis'],
): string {
  switch (basis.kind) {
    case 'incumbent-absent':
      return basis.kind;
    case 'incumbent-unresolved':
    case 'incumbent-unusable':
      return `${basis.kind}: ${basis.cause}`;
    case 'invoking-identity-unavailable':
      return `${basis.kind}: ${basis.failure}`;
    case 'incumbent-identity-unavailable':
      return `${basis.kind}: ${basis.incumbent.version}, instance ${basis.incumbent.instanceId}`;
    case 'same-build-set':
      return `${basis.kind}: ${basis.buildSetId}`;
    case 'invoking-build-not-older':
      return `${basis.kind}: ${basis.comparison}, invoking ${basis.invoking.version}, incumbent ${basis.incumbent.version}`;
    case 'invalid-incumbent-target':
      return `${basis.kind}: ${basis.evidence.failure}`;
    default:
      return assertNever(basis);
  }
}

function formatSelectedRoutingDisposition(disposition: SelectedHandoffDisposition): string {
  switch (disposition.kind) {
    case 'continue-current':
      return `continued current (${formatSelectedRoutingBasis(disposition.basis)})`;
    case 'handoff-selected':
      return `selected ${disposition.source} handoff to ${disposition.target.build.version} (${disposition.target.build.flavor}, build set ${disposition.target.build.buildSetId}, bundle ${disposition.target.build.bundleHash})`;
    default:
      return assertNever(disposition);
  }
}

function formatRoutingOwnerLiveness(
  invocationId: string,
  disposition: SelectedHandoffDisposition,
  liveness: OwnerLiveness,
): string {
  const selectionEvidence = `Selected routing: ${formatSelectedRoutingDisposition(disposition)}.`;
  switch (liveness.kind) {
    case 'alive':
      return `Routing invocation ${invocationId}: in flight; its recorded owner is alive.`;
    case 'absent':
      return [
        `Routing invocation ${invocationId}: unresolved; its recorded owner is absent.`,
        selectionEvidence,
        `Next step: run coral-cli backend routing-status resolve --invocation ${invocationId}.`,
      ].join('\n');
    case 'unobservable':
      return liveness.cause === 'deadline-expired'
        ? [
            `Routing invocation ${invocationId}: unresolved; owner observation was unobservable (${liveness.cause}).`,
            selectionEvidence,
            'Next step: rerun coral-cli backend status; an expired sweep cannot authorize resolution.',
          ].join('\n')
        : [
            `Routing invocation ${invocationId}: unresolved; owner observation was unobservable (${liveness.cause}).`,
            selectionEvidence,
            `Next step: verify the owner externally, then run coral-cli backend routing-status resolve --invocation ${invocationId} --force-unobservable to abandon it.`,
          ].join('\n');
    default:
      return assertNever(liveness);
  }
}

type FinalizedDisposition = Extract<
  StoredTerminalDisposition,
  {
    kind:
      | 'continued-current'
      | 'delegated-success'
      | 'delegated-startup-observation-aborted'
      | 'delegated-exit'
      | 'delegated-signal';
  }
>;

export function formatHandoffStartupObservationAborted(outcome: HandoffStartupObservationAborted): string {
  return (
    `Handoff startup observation for Coral ${outcome.version} was aborted; detached child pid ` +
    `${outcome.child.pid} (incarnation ${outcome.child.incarnation}) was left running and unobserved. ` +
    'Coral will neither await nor terminate it.'
  );
}

function formatFinalizedDisposition(disposition: FinalizedDisposition): string {
  switch (disposition.kind) {
    case 'continued-current':
      switch (disposition.reason.kind) {
        case 'routing':
          return `continued current (${disposition.reason.basis.kind})`;
        case 'handoff-abandoned-stdout':
          return 'continued current after stdout drain prevented delegation';
        default:
          return assertNever(disposition.reason);
      }
    case 'delegated-success':
      return `delegated successfully to ${disposition.version}`;
    case 'delegated-startup-observation-aborted':
      return (
        `startup observation aborted after delegating to ${disposition.version}; detached child pid ` +
        `${disposition.child.pid} (incarnation ${disposition.child.incarnation}) was left running and unobserved, ` +
        'and Coral will neither await nor terminate it'
      );
    case 'delegated-exit':
      return `delegated to ${disposition.version}, which exited ${disposition.exitCode}`;
    case 'delegated-signal':
      return `delegated to ${disposition.version}, which exited on ${disposition.signal}`;
    default:
      return assertNever(disposition);
  }
}

function formatStoredTerminalDisposition(disposition: StoredTerminalDisposition): string {
  switch (disposition.kind) {
    case 'execution-failed':
      return `execution failed during ${disposition.throwPhase}`;
    case 'continued-current':
    case 'delegated-success':
    case 'delegated-startup-observation-aborted':
    case 'delegated-exit':
    case 'delegated-signal':
      return formatFinalizedDisposition(disposition);
    case 'failed-without-selection':
      return `execution failed during ${disposition.throwPhase} without a retained selection`;
    case 'finalized-without-selection':
      return `${formatFinalizedDisposition(disposition.terminal)} without a retained selection`;
    case 'terminal-without-retained-selection':
      return `${formatStoredTerminalDisposition(disposition.terminal)} after its selection identity expired or was unavailable`;
    case 'operator-resolved-without-retained-selection':
      return (
        `resolved by the operator (${disposition.resolutionReason}) without a retained selection; ` +
        `detached child pid ${disposition.resolvedChild.pid} (incarnation ${disposition.resolvedChild.incarnation}) ` +
        'was left running and unobserved'
      );
    case 'terminal-after-operator-resolution':
      return `${formatStoredTerminalDisposition(disposition.terminal)} after operator resolution (${disposition.resolutionReason})`;
    default:
      return assertNever(disposition);
  }
}

function formatRoutingInvocationStatus(status: HandoffRoutingInvocationStatus): string {
  switch (status.kind) {
    case 'unresolved':
      return formatRoutingOwnerLiveness(
        status.selection.invocationId,
        status.selection.disposition,
        status.ownerLiveness,
      );
    case 'terminal':
      return `Routing invocation ${status.terminal.invocationId}: terminal; ${formatStoredTerminalDisposition(status.terminal.disposition)}.`;
    case 'retired':
      switch (status.tombstone.retirementCause) {
        case 'selection-evicted-at-capacity': {
          const terminalEvidence = status.tombstone.terminalExisted
            ? 'terminal recorded: yes'
            : 'terminal recorded: no';
          return `Routing invocation ${status.tombstone.invocationId}: retired (selection-evicted-at-capacity; ${terminalEvidence}).\nSelected routing: ${formatSelectedRoutingDisposition(status.tombstone.selectedDisposition)}.\nNext step: run coral-cli backend routing-status resolve --invocation ${status.tombstone.invocationId} to acknowledge the retained capacity eviction.`;
        }
        case 'completed-pair-compaction':
          return `Routing invocation ${status.tombstone.invocationId}: retired (completed-pair-compaction). No action is needed.`;
        case 'operator-resolved':
          return `Routing invocation ${status.tombstone.invocationId}: retired (operator-resolved; reason: ${status.tombstone.resolutionReason}). No action is needed.`;
        default:
          return assertNever(status.tombstone.retirementCause);
      }
    default:
      return assertNever(status);
  }
}

function formatRetirementHistoryTruncated(history: RetirementHistoryTruncated): string | null {
  if (history.expiredIdentityCount === 0) return null;
  const causes = Object.entries(history.causes)
    .map(([cause, count]) => `${cause}=${count}`)
    .join(', ');
  return `Routing retirement history: ${history.expiredIdentityCount} exact invocation identities expired (${causes}); observed selection sequence range ${history.minSelectionSequence}-${history.maxSelectionSequence}, selected ${history.earliestSelectedAt} through ${history.latestSelectedAt}.`;
}

export function formatHandoffRoutingStatus(result: HandoffRoutingStatusReadResult): string | null {
  const renderKey = HANDOFF_ROUTING_STATUS_CLASSIFICATION_POLICY[result.kind].renderKey;
  switch (renderKey) {
    case 'no-journal':
      return null;
    case 'empty-file':
      return 'Routing status journal is empty; this is consistent with interrupted creation or truncation.';
    case 'initialization-incomplete':
      return 'Routing status initialization is incomplete; the journal contains no application objects.';
    case 'detached-wal':
      return [
        'Routing status has a detached non-empty WAL beside an absent or empty main database.',
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'no-generation':
      return [
        'Routing status contains application objects but no generation address.',
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'other-generation':
      if (result.kind !== 'foreign-generation') throw new Error('Foreign-generation render policy is invalid.');
      return [
        `Routing status generation ${result.generation} belongs to another address.`,
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'other-format':
      return [
        'Routing status has this generation address but a different durable format fingerprint.',
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'divergent-schema':
      return [
        'Routing status has this generation address but a divergent schema.',
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'damaged':
      if (result.kind !== 'unreadable') throw new Error('Unreadable render policy is invalid.');
      return [
        `Routing status is unreadable (${result.reason}).`,
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'could-not-observe':
      if (result.kind !== 'undeterminable') throw new Error('Undeterminable render policy is invalid.');
      return [
        `Routing status could not be read (${result.cause}, errcode ${result.errcode}).`,
        'Next step: retry coral-cli backend status without discarding. If this persists, repair the reported storage condition; discard is not permitted because this read did not establish a discardable classification.',
      ].join('\n');
    case 'content-dependent': {
      if (result.kind !== 'current') throw new Error('Current render policy is invalid.');
      const sections = result.statuses.map(formatRoutingInvocationStatus);
      const truncatedHistory = formatRetirementHistoryTruncated(result.retirementHistoryTruncated);
      if (truncatedHistory !== null) sections.push(truncatedHistory);
      return sections.length === 0 ? null : sections.join('\n');
    }
    default:
      return assertNever(renderKey);
  }
}

function formatUnavailableRoutingResolution(
  status: Extract<HandoffRoutingResolveResult, { kind: 'status-unavailable' }>['status'],
): string {
  switch (status.kind) {
    case 'detached-wal':
    case 'generation-missing':
    case 'foreign-generation':
    case 'format-mismatch':
    case 'schema-divergent':
    case 'unreadable':
      return 'Next step: run coral-cli backend status, then run the routing-status discard command it reports before attempting another resolution.';
    case 'undeterminable':
      return 'Next step: retry coral-cli backend status without discarding and repair the reported storage condition if it persists; resolution requires a current journal.';
    default:
      return assertNever(status);
  }
}

function formatRoutingResolutionPublicationSuccessor(
  result: Extract<
    HandoffRoutingResolveResult,
    { kind: 'artifact-refused' | 'not-published' | 'commit-outcome-unknown' }
  >,
): string {
  return formatHandoffPublicationFailureSuccessor({
    kind: 'resolution',
    invocationId: result.invocationId,
    outcome: result,
  });
}

export function formatAbandonedStartupChildSuccessor(invocationId: string): string {
  return (
    'Stop that exact child through the service or account that owns it. ' +
    'If it is the coordinator addressed by this Coral installation, run coral-cli backend shutdown. ' +
    'After that exact PID and incarnation are absent, rerun coral-cli backend status, then run ' +
    `coral-cli backend routing-status resolve --invocation ${invocationId}`
  );
}

export function formatHandoffRoutingResolveResult(result: HandoffRoutingResolveResult): string {
  switch (result.kind) {
    case 'resolved':
      return `Resolved routing invocation ${result.invocationId} (${result.reason}).`;
    case 'acknowledged-capacity-eviction':
      return `Acknowledged capacity eviction for routing invocation ${result.invocationId} (selection sequence ${result.selectionSequence}).`;
    case 'stale':
      return `Routing invocation ${result.invocationId} is stale or no longer retained.\nNext step: rerun coral-cli backend status and copy an invocation still shown as unresolved.`;
    case 'already-terminal':
      return `Routing invocation ${result.invocationId} is already terminal. No resolution is needed.\nNext step: no action is needed.`;
    case 'live-owner':
      return result.abandonedChild === undefined
        ? `Refusing to resolve routing invocation ${result.invocationId}: its recorded owner is alive.\nNext step: wait for the owner to finish, then rerun coral-cli backend status.`
        : `Refusing to resolve routing invocation ${result.invocationId}: detached startup child pid ${result.abandonedChild.pid} (incarnation ${result.abandonedChild.incarnation}) is alive.\nNext step: ${formatAbandonedStartupChildSuccessor(result.invocationId)}.`;
    case 'unauthorized-unobservable':
      return result.cause === 'deadline-expired'
        ? `Refusing to resolve routing invocation ${result.invocationId}: the owner sweep deadline expired.\nNext step: rerun coral-cli backend status, then retry without --force-unobservable; the flag cannot override an expired observation budget.`
        : `Refusing to resolve routing invocation ${result.invocationId}: owner observation is unobservable (${result.cause}).\nNext step: verify the owner externally, then rerun this command with --force-unobservable only if abandoning it is safe.`;
    case 'status-unavailable':
      return `Refusing to resolve routing status because the authoritative journal is ${result.status.kind}.\n${formatUnavailableRoutingResolution(result.status)}`;
    case 'not-published':
      return (
        `Routing resolution was not published (${result.kind}:${result.cause}).\n` +
        formatRoutingResolutionPublicationSuccessor(result)
      );
    case 'artifact-refused':
      return (
        `Routing resolution publication refused the ${result.classification.kind} journal.\n` +
        formatRoutingResolutionPublicationSuccessor(result)
      );
    case 'commit-outcome-unknown':
      return (
        `Routing resolution publication could not be determined (${result.cause}, errcode ${result.errcode}).\n` +
        formatRoutingResolutionPublicationSuccessor(result)
      );
    default:
      return assertNever(result);
  }
}

// Deliberately not "not running": the record exists and could not be read, which says nothing about whether a
// coordinator is serving. The remedy names the file because nothing in Coral rewrites it while a coordinator is
// up — it is written once at startup — so an operator is the only party who can clear it.
//
// The remedy is the operator rather than a coral-cli command because every command that could stop a
// coordinator needs its host, port and boot token, and all three live in the record this status exists to
// report unreadable. Nothing that reads them can act while it cannot be read.
function formatUndecodableRecordStatus(result: Extract<BackendStatusFull, { status: 'undecodable_record' }>): string {
  return [
    `Backend state is unknown: the coordinator discovery record could not be read (${result.reason}).`,
    'A coordinator may still be running; this is not a report that none is.',
    `Next step: no coral-cli command can stop a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete ${result.path} and run a coral-cli mutating command; it attempts startup or handoff.`,
  ].join('\n');
}

// Deliberately not "not running": something answered at the recorded address, the address refused a
// connection, or the request to it did not complete. `cause` distinguishes those three, since only a received
// response proves anything is listening and only a refusal proves nothing is.
function formatUnreachableStatus(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  return [
    `Backend state is unknown: the coordinator did not give a usable answer (${result.detail}).`,
    formatUnreachableCauseLine(result),
    formatUnreachableNextStep(result),
  ].join('\n');
}

function formatUnreachableCauseLine(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  switch (result.cause) {
    case 'responded':
      return 'Something is listening at the recorded address; this is not a report that the backend stopped.';
    case 'refused':
      return result.pidLiveness === 'alive'
        ? "Nothing is listening at the recorded address, though the recorded pid still belongs to a running process — a coordinator's HTTP listener can close before that process finishes shutting down, and a reused pid looks the same from here, so this alone does not mean the backend stopped."
        : 'Nothing is listening at the recorded address, and the recorded process could not be independently confirmed alive or gone before this request was sent.';
    case 'no_response':
      return 'The request to the recorded address never completed; this is not a report that the backend stopped, and nothing observed here says whether anything is listening.';
    default:
      return assertNever(result);
  }
}

// `refused` is the one cause here `backend shutdown` already resolves for the identical evidence
// (`formatSocketRefused`): a reused pid never clears by retrying, so this arm names the same check-and-clear
// remedy instead of leaving an operator to retry a hold that cannot end that way.
function formatUnreachableNextStep(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  switch (result.cause) {
    case 'responded':
    case 'no_response':
      return 'Next step: retry, and check the coordinator logs if it persists.';
    case 'refused':
      return `Next step: retry shortly — a drain finishes on its own. If it keeps refusing, the record may name a pid something else now holds: run 'ps -p ${result.pid}' (or check your process manager), and if that is not Coral, delete ${result.recordPath} and run a coral-cli mutating command; it attempts startup or handoff.`;
    default:
      return assertNever(result);
  }
}

// Not "not running": the coordinator's own IPC socket file exists, which a coordinator mid-boot and a stale
// socket a killed one left behind both produce, indistinguishably — see CoordinatorObservation in
// src/transport/http/backend/coordinator-observation.ts.
function formatNoRecordSocketPresentStatus(
  result: Extract<BackendStatusFull, { status: 'no_record_socket_present' }>,
): string {
  return [
    'Backend state is unknown: the coordinator IPC socket exists, but no discovery record has been written yet.',
    `Socket: ${result.socketPath}`,
    'A coordinator may still be starting, or this may be a stale socket left by one that did not exit cleanly; this is not a report that the backend is running or that it has stopped.',
    'Next step: retry shortly — a coordinator mid-boot writes its record within seconds, and how long this persists does not by itself tell a stale socket from one still starting. Run a coral-cli mutating command (or start a Claude Code session) either way; it attempts startup or handoff. If it reports the backend unreachable, the coordinator log is what says why.',
  ].join('\n');
}

// "This build does not document it" may be said only about a code some other build wrote. A code the running
// build itself recorded has no upgrade that adds it, so its unrenderable case names the log instead.
function formatUnrecognizedSetupErrorLines(
  setupError: Extract<OperatorFacingCoralSetupError, { kind: 'unrecognized_code' }>,
): readonly string[] {
  const retry =
    "then retry a coral-cli mutating command; it attempts startup or handoff. Rerun coral-cli backend status to observe that attempt's result.";
  switch (setupError.authorship) {
    case 'this-build':
      return [
        `Cause: Coral recorded a setup refusal this build wrote, and the text recorded with it could not be re-read. [code=${setupError.code}]`,
        `Next step: inspect the coordinator log for that code, ${retry}`,
      ];
    case 'other-build':
      return [
        `Cause: Coral recorded a setup refusal from another Coral build, whose codes this build cannot name. [code=${setupError.code}]`,
        `Next step: inspect the coordinator log for that code, upgrade Coral, ${retry}`,
      ];
    case 'unprovable':
      return [
        `Cause: Coral recorded a setup refusal and could not prove which Coral build wrote it. [code=${setupError.code}]`,
        `Next step: inspect the coordinator log for that code, ${retry}`,
      ];
    default:
      return assertNever(setupError.authorship);
  }
}

function formatSetupErrorLines(setupError: OperatorFacingCoralSetupError): readonly string[] {
  switch (setupError.kind) {
    case 'documented':
    case 'self_authored':
      return [`Cause: ${setupError.userMessage} [code=${setupError.code}]`, `Next step: ${setupError.remediation}`];
    case 'unrecognized_code':
      return formatUnrecognizedSetupErrorLines(setupError);
    case 'invalid_diagnostic':
      return [
        'Cause: Coral recorded a setup refusal whose authored text could not be reconstructed.',
        'Next step: inspect the coordinator log, then retry a coral-cli mutating command so a current valid startup diagnostic replaces this one.',
      ];
    default:
      return assertNever(setupError);
  }
}

function formatRecentFailureStatus(result: Extract<BackendStatusFull, { status: 'recent_failure' }>): string {
  const lines = [
    'Coral recorded a recent coordinator failure.',
    `Phase: ${result.phase}`,
    `Retryable: ${result.retryable ? 'yes' : 'no'}`,
  ];
  if (result.setupError === undefined) {
    // A failure that is not a setup error has no authored remediation, and its raw message can carry provider
    // payloads or credentials, so the log stays the only place it is rendered.
    lines.push(
      'Next step: inspect the coordinator log, fix the reported cause, then retry a coral-cli mutating command; it attempts startup or handoff.',
    );
    return lines.join('\n');
  }
  return [...lines, ...formatSetupErrorLines(result.setupError)].join('\n');
}

export function formatShutdown(result: ShutdownResult): string {
  if (result.ok) {
    return result.alreadyDraining ? 'Backend shutdown already in progress' : 'Backend shutdown initiated';
  }
  switch (result.reason) {
    case 'unreadable_record':
      return formatUnreadableRecordShutdown(result.detail);
    case 'refused_by_response':
      return formatRefusedByResponse(result.detail);
    case 'no_response':
      return formatNoResponse(result.detail);
    case 'no_record':
      return [
        'Shutdown not attempted: no coordinator discovery record was found.',
        'A coordinator may still be serving at an address this build can neither derive nor read from a record; this is not a report that it stopped.',
        SHUTDOWN_UNPUBLISHED_COORDINATOR_NEXT_STEP,
      ].join('\n');
    case 'recorded_process_absent':
      return [
        `Shutdown not attempted: the recorded coordinator process (pid ${result.detail}) is gone.`,
        'A different coordinator may still be starting without having published its own record; this is not a report that the backend stopped.',
        SHUTDOWN_UNPUBLISHED_COORDINATOR_NEXT_STEP,
      ].join('\n');
    case 'socket_refused':
      return formatSocketRefused(result);
    case 'nested_child':
      return [
        'Shutdown refused: this nested Coral process cannot shut down its parent coordinator.',
        "Next step: return to the top-level Coral session and run 'coral-cli backend shutdown' there.",
      ].join('\n');
    case 'capability_rejected':
      return formatCapabilityRejected(result);
    case 'no_record_socket_present':
      return formatNoRecordSocketPresentShutdown();
    default:
      return assertNever(result);
  }
}

// No coral-cli command reaches this: shutdown needs host/port/bootToken from the very record it just failed to
// read, so the manual path is the only one that exists. `backend status` is named only for the file's path,
// not as a command that can stop anything here.
function formatUnreadableRecordShutdown(detail: string): string {
  return [
    `Shutdown not attempted: the coordinator discovery record could not be read (${detail}).`,
    'A coordinator may still be running; this is not confirmation that one stopped.',
    'Next step: no coral-cli command can dial a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete the record file (run coral-cli backend status to see its path) and run a coral-cli mutating command to relaunch.',
  ].join('\n');
}

// A response arrived — the mirror of `formatUnreachableStatus`'s `'responded'` cause: something is listening.
function formatRefusedByResponse(detail: string): string {
  return [
    `Shutdown not confirmed: the coordinator responded but did not accept the request (${detail}).`,
    'Something is listening at the recorded address; this is not a report that it stopped.',
    SHUTDOWN_RETRY_NEXT_STEP,
  ].join('\n');
}

// No response ever arrived — the mirror of `formatUnreachableStatus`'s `'no_response'` cause: nothing here
// proves anything is listening, but nothing proves the opposite either.
function formatNoResponse(detail: string): string {
  return [
    `Shutdown not confirmed: the request to the coordinator did not complete (${detail}).`,
    'The coordinator may still be running and may still be serving; this is not a report that it stopped.',
    SHUTDOWN_RETRY_NEXT_STEP,
  ].join('\n');
}

// Mirrors `formatBackendStatus`'s `no_record_socket_present` case: the coordinator's own IPC socket exists
// with no record written yet, so a boot in progress and a stale leftover socket are equally possible.
function formatNoRecordSocketPresentShutdown(): string {
  return [
    'Shutdown not attempted: the coordinator IPC socket exists, but no discovery record has been written yet.',
    'A coordinator may still be starting, or this may be a stale socket left by one that did not exit cleanly; this is not a report that it stopped.',
    // Not `SHUTDOWN_RETRY_NEXT_STEP`: `backend status` is a read, so for a stale socket it reports this same
    // state forever and the two commands loop. Relaunching is what ends it — binding clears a stale socket.
    'Next step: retry shortly in case a coordinator is mid-boot — how long this persists does not by itself tell a stale socket from one still starting. Run a coral-cli mutating command (or start a Claude Code session) either way: it binds and relaunches if the socket was stale, and if it instead reports the backend unreachable, the coordinator log is what says why. Once it relaunches, retry the shutdown.',
  ].join('\n');
}

// A refused connection is never grounds for "not running" here: an absent pid is excluded before this request
// is ever sent (see ShutdownResult in src/transport/http/backend/shutdown.ts), so `pidLiveness` is always `'alive'` or `'unknown'`
// — and `'alive'` is the deterministic mid-drain window where the coordinator's HTTP listener has closed while
// the process keeps running. Neither case may claim the backend stopped.
//
// `'alive'` says the recorded pid still belongs to a running process, and nothing more — a pid is reused, so
// it cannot separate Coral's coordinator from whatever now holds that number (see `observeProcessLiveness` in
// `src/infra/node-process.ts`). That second reading is why retrying is not the only exit offered — a drain finishes on
// its own, a record naming a stranger's pid never does, and the two are indistinguishable from here.
function formatSocketRefused(result: Extract<ShutdownResult, { reason: 'socket_refused' }>): string {
  const whatRefusalMeans =
    result.pidLiveness === 'alive'
      ? `The recorded pid ${result.pid} still belongs to a running process, but the admin socket refused the connection — a coordinator's HTTP listener can close before the process finishes shutting down, so this alone does not mean the backend stopped.`
      : `The coordinator socket refused the connection, and the recorded process (pid ${result.pid}) could not be independently confirmed alive or gone before this request was sent.`;
  return [
    `Shutdown not confirmed: ${whatRefusalMeans}`,
    'The coordinator may still be running; this is not a report that it stopped.',
    `Next step: retry shortly — a drain finishes on its own. If it keeps refusing, the record may name a pid something else now holds: run 'ps -p ${result.pid}' (or check your process manager), and if that is not Coral, delete ${result.recordPath} and run a coral-cli mutating command to relaunch.`,
  ].join('\n');
}

// The 401 proves a coordinator answers at the recorded address and rejected our token; it proves nothing about
// the pid beyond what was already known before this request was sent. `pidLiveness` carries that prior
// observation, so the sentence claims only what was actually confirmed, not what the 401 implies.
function formatCapabilityRejected(result: Extract<ShutdownResult, { reason: 'capability_rejected' }>): string {
  const pid = result.detail;
  const whatRespondedMeans =
    result.pidLiveness === 'alive'
      ? `A coordinator is running at the recorded address and did not accept the request, so no retry of this command will get in — the recorded pid ${pid} still belongs to a running process, but a pid is reused, so that alone does not confirm it is this coordinator.`
      : `A coordinator is running at the recorded address and did not accept the request, so no retry of this command will get in — but the recorded pid (${pid}) was not independently confirmed alive, so do not act on the pid alone.`;
  return [
    "Shutdown refused: the coordinator rejected the boot token in this build's discovery record.",
    whatRespondedMeans,
    'Next step: run coral-cli backend status to see which build is answering; if it is not this one, shut it down from its own install, or confirm with your process manager that the recorded pid is still the process serving that address before stopping it directly.',
  ].join('\n');
}

export function formatRecoveryQuarantineList(entries: readonly RecoveryQuarantineListEntry[]): string {
  if (entries.length === 0) {
    return 'Recovery quarantine is empty.';
  }

  const lines = [`Recovery quarantine (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}):`];
  for (const entry of entries) {
    lines.push(
      `- boundary=${JSON.stringify(entry.boundary)} key=${encodeRecoveryQuarantineKey(entry.subject.key)} revision=${JSON.stringify(
        formatRecoveryRevision(entry),
      )} state=${entry.state} stage=${entry.stage}`,
      `  detected_at=${entry.detectedAt ?? 'unavailable'} updated_at=${entry.updatedAt ?? 'unavailable'}`,
    );
    if (entry.retry !== null) {
      lines.push(`  retry_owner=${JSON.stringify(entry.retry.owner)} retry_token=${JSON.stringify(entry.retry.token)}`);
    }
    if (entry.continuation !== null) {
      lines.push(
        `  continuation_kind=${JSON.stringify(entry.continuation.kind)} continuation_key=${JSON.stringify(entry.continuation.key)}`,
      );
    }
    lines.push(`  error=${JSON.stringify(entry.errorMessage)}`, `  detail=${JSON.stringify(entry.detail)}`);
    if (
      entry.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY &&
      entry.state === 'active' &&
      entry.retry === null &&
      entry.continuation === null &&
      entry.subject.revision.kind === 'fingerprint' &&
      /^sha256:[0-9a-f]{64}$/u.test(entry.subject.revision.value) &&
      isProviderOperationRecordKey(entry.subject.key) &&
      entry.detectedAt !== null &&
      entry.updatedAt !== null
    ) {
      lines.push(
        `  discard=coral-cli backend recovery-quarantine discard-provider-operation --key ${encodeRecoveryQuarantineKey(entry.subject.key)} --revision ${JSON.stringify(formatRecoveryRevision(entry))}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatRecoveryQuarantineClear(result: RecoveryQuarantineClearResult): string {
  const coordinate = `boundary=${JSON.stringify(result.boundary)} key=${encodeRecoveryQuarantineKey(
    result.key,
  )} revision=${JSON.stringify(formatRecoveryRevisionValue(result.revision))}`;
  switch (result.disposition) {
    case 'advanced':
      return `Recovery quarantine resolved and removed: ${coordinate}`;
    case 'quarantined':
      return `Recovery retry failed again; the subject is still quarantined: ${coordinate}. Run coral-cli backend recovery-quarantine list to inspect the updated error.`;
    case 'continuation':
      return `Recovery retry made partial progress: ${coordinate}. Run coral-cli backend recovery-quarantine list to inspect the durable continuation; do not run clear again with this coordinate.`;
    default:
      return assertNever(result.disposition);
  }
}

export function formatUnreadableProviderOperationDiscard(result: UnreadableProviderOperationDiscardResult): string {
  const coordinate = `key=${encodeRecoveryQuarantineKey(result.key)} revision=${JSON.stringify(
    `${RECOVERY_REVISION_FINGERPRINT_PREFIX}${result.revision}`,
  )}`;
  switch (result.kind) {
    case 'discarded':
      return [
        `Discarded unreadable provider-operation row ${coordinate}.`,
        'Observed: the exact raw-row coordinate was still unreadable and the transactional discard completed.',
        'Not observed: process state or an operation-settlement outcome.',
        'Effect: the exact raw operation record, every known-generation due pointer to it, and its quarantine evidence were permanently removed in one transaction; no process was signalled and the operation was not settled.',
        'Next step: run coral-cli backend recovery-quarantine list, then run coral-cli backend status.',
      ].join('\n');
    case 'absent':
      return [
        `Refusing discard for ${coordinate}: the raw row is absent.`,
        'Observed: the exact raw-row key was absent after the quarantine subject was claimed.',
        'Not observed: process state or an operation-settlement outcome.',
        'Effect: nothing was removed and the temporary discard claim was released.',
        'Next step: run coral-cli backend recovery-quarantine list.',
      ].join('\n');
    case 'readable':
      return [
        `Refusing discard for ${coordinate}: this build can now read the row.`,
        'Observed: the exact raw row decoded under this build.',
        'Not observed: process state or an operation-settlement outcome.',
        'Effect: nothing was removed and the temporary discard claim was released.',
        `Next step: run coral-cli backend recovery-quarantine clear --boundary ${UNREADABLE_PROVIDER_OPERATION_BOUNDARY} --key ${encodeRecoveryQuarantineKey(result.key)} --revision ${JSON.stringify(`${RECOVERY_REVISION_FINGERPRINT_PREFIX}${result.revision}`)}.`,
      ].join('\n');
    case 'revision-mismatch':
      return [
        `Refusing discard for ${coordinate}: the exact recovery coordinate now has revision ${JSON.stringify(`${RECOVERY_REVISION_FINGERPRINT_PREFIX}${result.currentRevision}`)}.`,
        'Observed: either the persisted quarantine subject or the raw row carries a different fingerprint.',
        'Not observed: which persisted source changed; the result reports only the current authority fingerprint.',
        'Effect: nothing was removed and any temporary discard claim was released.',
        'Next step: run coral-cli backend recovery-quarantine list and inspect the new exact revision.',
      ].join('\n');
    case 'quarantine-not-found':
      return [
        `No discard verdict for ${coordinate}: the exact persisted quarantine subject is absent.`,
        'Observed: no persisted quarantine subject authorizes this exact coordinate.',
        'Not observed: the raw row contents, because no discard authority was established.',
        'Effect: the raw row and due pointers were not changed.',
        'Next step: start or repair the canonical coordinator, then run coral-cli backend recovery-quarantine list and use only a currently printed discard command.',
      ].join('\n');
    case 'owned':
      return [
        `No discard verdict for ${coordinate}: recovery currently owns the exact quarantine subject in state ${result.state}.`,
        `Observed: the exact quarantine subject is ${result.state} under another recovery owner.`,
        'Not observed: the raw row contents, because another recovery owner retains authority.',
        'Effect: the raw row, due pointers, and quarantine evidence were not changed.',
        'Next step: let that recovery owner finish, then run coral-cli backend recovery-quarantine list before deciding whether to retry.',
      ].join('\n');
    default:
      return assertNever(result);
  }
}

function formatRecoveryRevision(entry: RecoveryQuarantineListEntry): string {
  return entry.subject.revision.kind === 'fingerprint'
    ? formatRecoveryRevisionValue(entry.subject.revision.value)
    : RECOVERY_REVISION_UNTIL_CLEARED;
}

function formatRecoveryRevisionValue(revision: string | null): string {
  return revision === null ? RECOVERY_REVISION_UNTIL_CLEARED : `${RECOVERY_REVISION_FINGERPRINT_PREFIX}${revision}`;
}

type RunningHealth = Extract<BackendStatusFull, { status: 'ok' }>['health'];
type RuntimeComponent = BackendHealth['components'][number];
type DegradedReason = Extract<RuntimeComponent, { phase: 'degraded' }>['reason'];

function formatRunningStatus(health: RunningHealth): string {
  const componentLines: string[] = [];
  for (const component of health.components) {
    componentLines.push(...formatComponentLines(component));
  }

  const lines: string[] = [
    `Backend ${health.status}`,
    `Version: ${health.version}`,
    `Uptime: ${formatDuration(health.uptimeMs)}`,
    formatKernelLine(health.kernel),
    `System provider scope: ${formatSystemProviderScope(health.systemProviderScope)}`,
    '',
    'Runtime Components:',
    ...componentLines,
    '',
    `Active jobs: ${health.activeJobs}`,
  ];
  if (typeof health.queueDepth === 'number') {
    lines.push(`Queue depth: ${health.queueDepth}`);
  }
  const providerProxySets = health.diagnostics?.providerProxySets ?? [];
  const skippedProviderProxySetRows = health.skippedProviderProxySetRows;
  if (providerProxySets.length > 0 || skippedProviderProxySetRows > 0) {
    lines.push('', 'Provider proxy sets:');
    const grouped = new Map<string, typeof providerProxySets>();
    for (const set of providerProxySets) {
      grouped.set(set.setToken, [...(grouped.get(set.setToken) ?? []), set]);
    }
    for (const [setToken, incidents] of grouped) {
      const current = incidents[0];
      if (current === undefined) continue;
      lines.push(
        `  set=${setToken} liveClaims=${current.liveClaims ?? 'unknown'}`,
        `    identity buildSetId=${current.setIdentity.buildSetId} proxyInstanceId=${current.setIdentity.proxyInstanceId} hostFingerprint=${current.setIdentity.hostFingerprint}`,
      );
      for (const incident of incidents) {
        const subject = [incident.role, incident.method].filter((value) => value !== undefined).join(' ');
        const reattachment =
          incident.cause === undefined
            ? ''
            : ` cause=${incident.cause} attempts=${incident.attempts ?? 'unknown'} elapsedMs=${incident.elapsedMs ?? 'unknown'} boundMs=${incident.boundMs ?? 'unknown'}`;
        lines.push(
          `    - disposition=${incident.disposition}${subject.length === 0 ? '' : ` subject=${subject}`} incident=${incident.incidentReason} waitingFor=${incident.waitingFor}${reattachment}${incident.enforcerObservations === undefined ? '' : ` enforcers=${incident.enforcerObservations.map(({ role, observation }) => `${role}:${observation}`).join(',')}`}`,
        );
      }
      if (
        incidents.some(
          ({ waitingFor }) =>
            waitingFor === 'control-reattachment' ||
            waitingFor === 'independent-containment-absence' ||
            waitingFor === 'set-adoption-deadline' ||
            waitingFor === 'operator-abandonment' ||
            waitingFor === 'store-repair',
        )
      ) {
        lines.push(`    action=coral-cli backend provider-proxy-set contain ${setToken}`);
      }
    }
    if (skippedProviderProxySetRows > 0) {
      lines.push(
        `  Provider proxy set rows this build could not read: ${skippedProviderProxySetRows}; backend status is not showing ${skippedProviderProxySetRows === 1 ? 'its disposition, cause, or waiting condition' : 'their dispositions, causes, or waiting conditions'}.`,
      );
      for (const setToken of health.skippedProviderProxySetTokens) {
        lines.push(`    action=coral-cli backend provider-proxy-set contain ${setToken}`);
      }
      const unaddressableRows = skippedProviderProxySetRows - health.skippedProviderProxySetTokens.length;
      if (unaddressableRows > 0) {
        lines.push(
          `    ${unaddressableRows} skipped ${unaddressableRows === 1 ? 'row has' : 'rows have'} no validated exact-set token; no containment command is available. Run coral-cli backend status from a build that understands the row.`,
        );
      }
    }
  }
  return lines.join('\n');
}

function formatSystemProviderScope(scope: RunningHealth['systemProviderScope']): string {
  if (scope === undefined) return 'unconfigured';
  return `${scope.name} (${scope.providers.join(', ')})`;
}

function formatKernelLine(kernel: RunningHealth['kernel']): string {
  if (kernel.readyAt === null) return `Kernel: ${kernel.phase}`;
  return `Kernel: ${kernel.phase} since ${new Date(kernel.readyAt).toISOString()}`;
}

function formatComponentLines(component: RuntimeComponent): string[] {
  const head = `  ${component.id}: ${component.phase}`;
  switch (component.phase) {
    case 'online':
      return [head];
    case 'initializing':
      return [head, `    attempt: ${component.attempt}`];
    case 'degraded': {
      const lines = [head, `    reason: ${component.reason.kind} (${formatDegradedDetail(component.reason)})`];
      if (component.reason.lastError) {
        lines.push(`    last error: ${component.reason.lastError}`);
      }
      lines.push(`    hint: ${formatDegradedHint(component.reason)}`);
      return lines;
    }
    case 'offline': {
      const lines = [head, `    reason: ${component.reason}`];
      if (component.lastLogLine) {
        lines.push(`    last log: ${component.lastLogLine}`);
      }
      if (component.diagnostic?.failedStep) {
        lines.push(`    failed step: ${component.diagnostic.failedStep}`);
      }
      if (typeof component.diagnostic?.attempts === 'number') {
        lines.push(`    attempts: ${component.diagnostic.attempts}`);
      }
      if (component.diagnostic?.retry) {
        lines.push(`    retry: ${formatOfflineRetry(component.diagnostic.retry)}`);
      }
      lines.push(`    hint: ${formatOfflineHint(component.diagnostic?.retry)}`);
      return lines;
    }
    default:
      return assertNever(component);
  }
}

function formatOfflineRetry(retry: 'restart-daemon' | 'none'): string {
  switch (retry) {
    case 'restart-daemon':
      return 'daemon restart required';
    case 'none':
      return 'not retryable';
    default:
      return assertNever(retry);
  }
}

function formatOfflineHint(retry: 'restart-daemon' | 'none' | undefined): string {
  if (retry === 'none') {
    return 'review the failure details above; coral-cli kb reindex can rebuild a corrupt KB index';
  }
  return 'restart the daemon: coral-cli backend shutdown';
}

function formatDegradedDetail(reason: DegradedReason): string {
  switch (reason.kind) {
    case 'curate-publish':
      return `${reason.consecutiveFailures} consecutive failures`;
    case 'recovery-quarantine':
      return `${reason.count} unresolved ${reason.count === 1 ? 'row' : 'rows'}`;
    default:
      return assertNever(reason);
  }
}

function formatDegradedHint(reason: DegradedReason): string {
  switch (reason.kind) {
    case 'curate-publish':
      return 'free disk space, then coral-cli backend shutdown to reset';
    case 'recovery-quarantine':
      return 'inspect quarantined recovery work: coral-cli backend recovery-quarantine list';
    default:
      return assertNever(reason);
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
