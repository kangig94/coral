import { assertNever } from '../../infra/error-format.js';
import type { HandoffRoutingBasis } from '../../coordinator/handoff-routing.js';
import type {
  HandoffRoutingInvocationStatus,
  HandoffRoutingResolveResult,
  HandoffRoutingStatusReadResult,
  OwnerLiveness,
  RetirementHistoryTruncated,
  SelectedHandoffDisposition,
  StoredTerminalDisposition,
} from '../../coordinator/handoff-routing-status.js';
import {
  liveHandoffResultObligation,
  type HandoffContinuationReason,
  type LiveHandoffResult,
} from '../../coordinator/handoff-runner.js';
import { encodeRecoveryQuarantineKey, type RecoveryQuarantineListEntry } from '../../recovery/quarantine.js';
import type { BackendHealth } from '../../transport/http/backend/health.js';
import type { BackendStatusFull } from '../../transport/http/backend/status.js';
import type { ShutdownResult } from '../../transport/http/backend/shutdown.js';
import type { RecoveryQuarantineClearResult } from '../../recovery/source-registry.js';
import { encodeProviderProxySetAddress } from '../../coordinator/services/provider-proxy-set/identity.js';
import type { ProviderProxySetContainResponse } from '../../transport/rpc/catalog.js';
import { formatHandoffPublicationFailureSuccessor } from './handoff-publication.js';

export const RECOVERY_REVISION_UNTIL_CLEARED = 'until-cleared';
export const RECOVERY_REVISION_FINGERPRINT_PREFIX = 'fingerprint:';

function formatProviderProxySetClaimDischarge(
  discharge: Extract<ProviderProxySetContainResponse, { kind: 'contained' | 'abandoned' }>['claimDischarge'],
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
  switch (result.kind) {
    case 'contained':
      return [
        `Confirmed absence for provider proxy set ${token}: the proxy process group and every recorded provider root were confirmed absent.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'The guardian and reaper were not signalled; if either remains live, its own adoption deadline is its exit.',
      ].join('\n');
    case 'abandoned':
      return [
        `Coral accepted operator abandonment for provider proxy set ${token}; process absence was not observed.`,
        `Enforcer observations: ${result.enforcerObservations.map(({ role, observation }) => `${role}=${observation}`).join(', ')}.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'Verify the proxy, guardian, reaper, and any provider processes externally. The guardian and reaper were not signalled; their own adoption deadline remains their named exit.',
      ].join('\n');
    case 'set-not-found':
      return `Provider proxy set ${token} is not represented by this coordinator. Run coral-cli backend status and copy the current exact token.`;
    case 'not-held':
      return `Refusing forced containment for ${token}: the set is ${result.state}, not held. Use ordinary drain for a healthy set, then inspect backend status.`;
    case 'deadline-pending':
      return `Refusing forced containment for ${token}: its autonomous adoption deadline has ${Math.ceil(result.remainingMs)}ms remaining. Wait for that event, then rerun ${retry}.`;
    case 'authorization-stale':
      return `Refusing forced containment for ${token}: the held attempt changed while Coral gathered containment evidence. Rerun ${retry} against the current hold.`;
    case 'enforcer-alive':
      return `Refusing to signal ${token}: enforcer observations were ${result.enforcerObservations.map(({ role, observation }) => `${role}=${observation}`).join(', ')}. After external verification, run ${retry} --abandon-unobservable to release Coral's representation without asserting process absence.`;
    case 'enforcer-unobservable':
      return `No containment verdict for ${token}: enforcer observations were ${result.enforcerObservations.map(({ role, observation }) => `${role}=${observation}`).join(', ')}. Restore process observation and rerun ${retry}, or after external verification run it with --abandon-unobservable.`;
    case 'store-unreadable':
      return `Refusing forced containment for ${token}: an unreadable durable provider-operation row may hide a provider root. --abandon-unobservable cannot override Coral's own store fence. Run coral-cli backend recovery-quarantine list, repair or remove the row named by its key and revision, run backend recovery-quarantine clear with that exact coordinate, then rerun backend status and ${retry}.`;
    default:
      return assertNever(result);
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
          ? 'Next step: run coral-cli backend shutdown, then run any coral-cli mutating command (or start a Claude Code session) to relaunch the backend from the current installation.'
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
        'Next step: run coral-cli backend shutdown, then rerun a mutating command to relaunch from this installation.',
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
    'Next step: run coral-cli backend shutdown, then rerun a mutating command to relaunch from this installation.';
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
    case 'not_running':
      return 'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.';
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
      return 'Backend unauthorized. The discovery record and daemon token disagree — run coral-cli backend shutdown, then retry to relaunch with a fresh token.';
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
  { kind: 'continued-current' | 'delegated-success' | 'delegated-exit' | 'delegated-signal' }
>;

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
    case 'delegated-exit':
    case 'delegated-signal':
      return formatFinalizedDisposition(disposition);
    case 'failed-without-selection':
      return `execution failed during ${disposition.throwPhase} without a retained selection`;
    case 'finalized-without-selection':
      return `${formatFinalizedDisposition(disposition.terminal)} without a retained selection`;
    case 'terminal-without-retained-selection':
      return `${formatStoredTerminalDisposition(disposition.terminal)} after its selection identity expired or was unavailable`;
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
  switch (result.kind) {
    case 'absent':
      return null;
    case 'unreadable':
      return [
        `Routing status is unreadable (${result.reason}).`,
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'unsupported-generation':
      return [
        `Routing status generation ${result.generation} is not supported by this build.`,
        'Next step: run coral-cli backend routing-status discard.',
      ].join('\n');
    case 'undeterminable':
      return [
        `Routing status could not be read (${result.cause}, errcode ${result.errcode}).`,
        'Next step: retry coral-cli backend status without discarding. If this persists, repair the reported storage condition; discard is not permitted because this read did not establish that the journal is unreadable or unsupported.',
      ].join('\n');
    case 'current': {
      const sections = result.statuses.map(formatRoutingInvocationStatus);
      const truncatedHistory = formatRetirementHistoryTruncated(result.retirementHistoryTruncated);
      if (truncatedHistory !== null) sections.push(truncatedHistory);
      return sections.length === 0 ? null : sections.join('\n');
    }
    default:
      return assertNever(result);
  }
}

function formatUnavailableRoutingResolution(
  status: Extract<HandoffRoutingResolveResult, { kind: 'status-unavailable' }>['status'],
): string {
  switch (status.kind) {
    case 'unreadable':
    case 'unsupported-generation':
      return 'Next step: run coral-cli backend status, then run the routing-status discard command it reports before attempting another resolution.';
    case 'undeterminable':
      return 'Next step: retry coral-cli backend status without discarding and repair the reported storage condition if it persists; resolution requires a current journal.';
    default:
      return assertNever(status);
  }
}

function formatRoutingResolutionPublicationSuccessor(
  result: Extract<HandoffRoutingResolveResult, { kind: 'not-published' | 'undeterminable' }>,
): string {
  return formatHandoffPublicationFailureSuccessor({
    kind: 'resolution',
    invocationId: result.invocationId,
    outcome: result,
  });
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
      return `Refusing to resolve routing invocation ${result.invocationId}: its recorded owner is alive.\nNext step: wait for the owner to finish, then rerun coral-cli backend status.`;
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
    case 'undeterminable':
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
    `Next step: no coral-cli command can stop a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete ${result.path} and run a coral-cli mutating command to relaunch.`,
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
      return `Next step: retry shortly — a drain finishes on its own. If it keeps refusing, the record may name a pid something else now holds: run 'ps -p ${result.pid}' (or check your process manager), and if that is not Coral, delete ${result.recordPath} and run a coral-cli mutating command to relaunch.`;
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
    'Next step: retry shortly — a coordinator mid-boot writes its record within seconds, and how long this persists does not by itself tell a stale socket from one still starting. Run a coral-cli mutating command (or start a Claude Code session) either way: it binds and relaunches if the socket was stale, and if it instead reports the backend unreachable, the coordinator log is what says why.',
  ].join('\n');
}

function formatRecentFailureStatus(result: Extract<BackendStatusFull, { status: 'recent_failure' }>): string {
  const lines = [
    'Backend is not running after a recent coordinator failure.',
    `Phase: ${result.phase}`,
    `Retryable: ${result.retryable ? 'yes' : 'no'}`,
  ];
  if (result.setupError === undefined) {
    // Undocumented failures have no authored remediation, and their raw message can carry provider payloads or
    // credentials, so the log stays the only place it is rendered.
    lines.push(
      'Next step: inspect the coordinator log, fix the reported cause, then retry a coral-cli mutating command to relaunch it.',
    );
  } else {
    lines.push(`Cause: ${result.setupError.userMessage} [code=${result.setupError.code}]`);
    lines.push(`Next step: ${result.setupError.remediation}`);
  }
  return lines.join('\n');
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
    for (const set of providerProxySets) {
      const subject = [set.role, set.method].filter((value) => value !== undefined).join(' ');
      const reattachment =
        set.cause === undefined
          ? ''
          : ` cause=${set.cause} attempts=${set.attempts ?? 'unknown'} elapsedMs=${set.elapsedMs ?? 'unknown'} boundMs=${set.boundMs ?? 'unknown'}`;
      lines.push(
        `  set=${set.setToken} buildSetId=${set.setIdentity.buildSetId} proxyInstanceId=${set.setIdentity.proxyInstanceId} hostFingerprint=${set.setIdentity.hostFingerprint}`,
        `    disposition=${set.disposition}${subject.length === 0 ? '' : ` subject=${subject}`} incident=${set.incidentReason} waitingFor=${set.waitingFor} liveClaims=${set.liveClaims ?? 'unknown'}${reattachment}${set.enforcerObservations === undefined ? '' : ` enforcers=${set.enforcerObservations.map(({ role, observation }) => `${role}:${observation}`).join(',')}`}`,
      );
    }
    if (skippedProviderProxySetRows > 0) {
      lines.push(
        `  Provider proxy set rows this build could not read: ${skippedProviderProxySetRows}; backend status is not showing ${skippedProviderProxySetRows === 1 ? 'its disposition, cause, or waiting condition' : 'their dispositions, causes, or waiting conditions'}.`,
      );
      for (const setToken of health.skippedProviderProxySetTokens) {
        lines.push(`    set=${setToken} (contain with: coral-cli backend provider-proxy-set contain ${setToken})`);
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
