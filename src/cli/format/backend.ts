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
  handoffRoutingInvocationClassification,
} from '../../coordinator/handoff-routing/status.js';
import {
  liveHandoffResultObligation,
  type HandoffContinuationReason,
  type LiveHandoffResult,
} from '../../coordinator/handoff-routing/runner.js';
import { encodeRecoveryQuarantineKey, type RecoveryQuarantineListEntry } from '../../recovery/quarantine.js';
import type { BackendHealth, ProviderProxySetRowSkip } from '../../transport/http/backend/health.js';
import type { BackendStatusFull, ShutdownRemainderReport } from '../backend-status.js';
import type { OperatorFacingCoralSetupError, SetupErrorAuthorshipKind } from '../../runtime/errors.js';
import type { ShutdownResult } from '../../transport/http/backend/shutdown.js';
import {
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
  type RecoveryQuarantineClearResult,
} from '../../recovery/source-registry.js';
import { encodeProviderProxySetAddress } from '../../provider-proxy/set-address.js';
import type {
  ProviderProxySetContainBooleanResponse,
  ProviderProxySetContainResponse,
} from '../../transport/rpc/catalog.js';
import type { UnreadableProviderOperationDiscardResult } from '../../recovery/unreadable-provider-operation.js';
import type { JobOperatorRemedy } from '../../jobs/contracts/operator-remedy.js';
import {
  type ProviderOperationRemedy,
  type RecoveryRecordRemedy,
  type RecoveryQuarantineCommand,
} from '../../recovery/provider-operation-remedy.js';
import type { ProviderProxySetLifecycleState } from '../../provider-proxy/set-lifecycle-state-vocabulary.js';
import type { ProviderProxySetOperatorExit } from '../../provider-proxy/operator-disposition-vocabulary.js';
import { isProviderOperationRecordKey } from '../../store/provider-operation-journal.js';
import { formatHandoffPublicationFailureSuccessor } from './handoff-publication.js';

export const RECOVERY_REVISION_UNTIL_CLEARED = 'until-cleared';
export const RECOVERY_REVISION_FINGERPRINT_PREFIX = 'fingerprint:';

type BackendOperatorCommand =
  | Readonly<{ kind: 'abort-job'; jobId: string }>
  | Readonly<{ kind: 'backend-status' }>
  | Readonly<{ kind: 'backend-shutdown' }>
  | Readonly<{ kind: 'jobs-detail'; jobId: string }>
  | Readonly<{ kind: 'kb-reindex' }>
  | Readonly<{ kind: 'provider-proxy-set-abandon'; token: string }>
  | Readonly<{ kind: 'provider-proxy-set-contain'; token: string }>
  | Readonly<{ kind: 'routing-status-discard' }>
  | Readonly<{ kind: 'routing-status-resolve'; invocationId: string; forceUnobservable: boolean }>;

type OperatorCommandLabel = 'action' | 'clear' | 'command' | 'discard';

function renderBackendOperatorCommand(command: BackendOperatorCommand): string {
  let commandArguments: string;
  switch (command.kind) {
    case 'abort-job':
      commandArguments = `abort jobs ${command.jobId}`;
      break;
    case 'backend-status':
      commandArguments = 'backend status';
      break;
    case 'backend-shutdown':
      commandArguments = 'backend shutdown';
      break;
    case 'jobs-detail':
      commandArguments = `jobs detail ${command.jobId}`;
      break;
    case 'kb-reindex':
      commandArguments = 'kb reindex';
      break;
    case 'provider-proxy-set-abandon':
      commandArguments = `backend provider-proxy-set abandon ${command.token}`;
      break;
    case 'provider-proxy-set-contain':
      commandArguments = `backend provider-proxy-set contain ${command.token}`;
      break;
    case 'routing-status-discard':
      commandArguments = 'backend routing-status discard';
      break;
    case 'routing-status-resolve':
      commandArguments =
        `backend routing-status resolve --invocation ${command.invocationId}` +
        (command.forceUnobservable ? ' --force-unobservable' : '');
      break;
    default:
      return assertNever(command);
  }
  return `coral-cli ${commandArguments}`;
}

function renderRecoveryQuarantineCommand(command: RecoveryQuarantineCommand): string {
  switch (command.kind) {
    case 'list':
      return 'coral-cli backend recovery-quarantine list';
    case 'clear':
      return (
        `coral-cli backend recovery-quarantine clear --boundary ${JSON.stringify(command.boundary)} ` +
        `--key ${encodeRecoveryQuarantineKey(command.key)} --revision ${JSON.stringify(command.revision)}`
      );
    case 'discard-provider-operation':
      return (
        `coral-cli backend recovery-quarantine discard-provider-operation ` +
        `--key ${encodeRecoveryQuarantineKey(command.key)} --revision ${JSON.stringify(command.revision)}` +
        (command.allowReadable ? ' --allow-readable' : '')
      );
  }
}

function formatBackendOperatorCommand(
  command: BackendOperatorCommand,
  label: OperatorCommandLabel = 'command',
): string {
  return `${label}=${renderBackendOperatorCommand(command)}`;
}

export function formatBackendStatusCommand(): string {
  return formatBackendOperatorCommand({ kind: 'backend-status' });
}

export function formatRecoveryQuarantineCommand(
  command: RecoveryQuarantineCommand,
  label: OperatorCommandLabel = 'command',
): string {
  return `${label}=${renderRecoveryQuarantineCommand(command)}`;
}

export function formatProviderOperationRemedy(
  remedy: ProviderOperationRemedy,
  label: OperatorCommandLabel = 'command',
): string {
  switch (remedy.kind) {
    case 'restart-coordinator':
      return 'Restart or repair the canonical coordinator externally; Coral retries ownership adoption during startup.';
    case 'remote-settlement':
      return 'Coral retries the remote settlement path automatically; re-check the operation after settlement.';
    case 'recovery-quarantine-discard':
      return [
        remedy.command.kind === 'list'
          ? 'Inspect the current quarantine row and use only the complete remedy it prints if losing that row is acceptable.'
          : 'If losing this exact row is acceptable, run the complete discard remedy below.',
        formatRecoveryQuarantineCommand(remedy.command, label),
      ].join('\n');
    case 'recovery-quarantine-clear':
      return [
        remedy.command.kind === 'list'
          ? 'Inspect the current quarantine row and use only the complete remedy it prints.'
          : 'Run the complete clear remedy below.',
        formatRecoveryQuarantineCommand(remedy.command, label),
      ].join('\n');
    case 'external-repair':
      return 'External repair of the reported provider-operation ownership path is required; no Coral command can repair it. Restart the coordinator after repair.';
  }
}

function formatJobOperatorRemedy(remedy: JobOperatorRemedy): string {
  const command = formatBackendOperatorCommand(remedy);
  switch (remedy.kind) {
    case 'abort-job':
      return [
        'Explicitly abandon this recovery ownership only if unresolved process life is acceptable.',
        command,
      ].join('\n');
    case 'jobs-detail':
      return ['Inspect the current job state.', command].join('\n');
  }
}

function formatRecoveryRecordRemedy(remedy: RecoveryRecordRemedy): string {
  if (remedy.kind === 'abort-job' || remedy.kind === 'jobs-detail') return formatJobOperatorRemedy(remedy);
  const label =
    remedy.kind === 'recovery-quarantine-discard' && remedy.command.kind === 'discard-provider-operation'
      ? 'discard'
      : remedy.kind === 'recovery-quarantine-clear' && remedy.command.kind === 'clear'
        ? 'clear'
        : 'command';
  return formatProviderOperationRemedy(remedy, label);
}

function recoveryRecordRemedyMatchesEntry(
  remedy: RecoveryRecordRemedy,
  entry: RecoveryQuarantineListEntry,
  isClearable: boolean,
): boolean {
  if (remedy.kind === 'abort-job' || remedy.kind === 'jobs-detail' || remedy.kind === 'external-repair') return true;
  if (remedy.kind === 'restart-coordinator' || remedy.kind === 'remote-settlement') return true;
  if (remedy.command.kind === 'list') return true;
  if (!isClearable) return false;
  if (remedy.command.kind === 'clear') {
    return (
      remedy.command.boundary === entry.boundary &&
      remedy.command.key === entry.subject.key &&
      remedy.command.revision === formatRecoveryRevision(entry)
    );
  }
  return (
    entry.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY &&
    entry.subject.revision.kind === 'fingerprint' &&
    /^sha256:[0-9a-f]{64}$/u.test(entry.subject.revision.value) &&
    isProviderOperationRecordKey(entry.subject.key) &&
    remedy.command.key === entry.subject.key &&
    remedy.command.revision === formatRecoveryRevision(entry)
  );
}

type ProviderProxySetOperatorRefusalGround = Extract<
  Extract<ProviderProxySetOperatorExit, { kind: 'refused' }>['ground'],
  (ProviderProxySetContainResponse | ProviderProxySetContainBooleanResponse)['kind']
>;

function formatProviderProxySetOperatorRefusalGuidance(
  ground: ProviderProxySetOperatorRefusalGround,
  token: string,
): string {
  const contain = formatBackendOperatorCommand({ kind: 'provider-proxy-set-contain', token });
  const abandon = formatBackendOperatorCommand({ kind: 'provider-proxy-set-abandon', token });
  switch (ground) {
    case 'enforcer-alive':
      return ['Next step: after external verification, run the abandon command below.', abandon].join('\n');
    case 'enforcer-unobservable':
      return [
        'Next step: restore process observation and run the contain command below; after external verification, the explicit alternative is the abandon command below.',
        contain,
        abandon,
      ].join('\n');
    case 'recorded-group-unattributable':
      return [
        "Next step: after external verification, run the abandon command below; abandonment releases Coral's representation without asserting absence or signalling the group.",
        abandon,
      ].join('\n');
    case 'signal-authorization-refused':
      return [
        "Next step: after external verification, run the abandon command below; abandonment releases Coral's representation without asserting absence.",
        abandon,
      ].join('\n');
    case 'identity-unobservable':
      return [
        'Next step: restore process-identity observation and run the contain command below; after external verification, the explicit alternative is the abandon command below.',
        contain,
        abandon,
      ].join('\n');
    case 'store-unreadable':
      return [
        'Next step: inspect the recovery quarantine.',
        formatProviderOperationRemedy({
          kind: 'recovery-quarantine-discard',
          command: { kind: 'list' },
        }),
      ].join('\n');
    default:
      return assertNever(ground);
  }
}

function formatProviderProxySetClaimDischarge(
  discharge: Extract<
    ProviderProxySetContainResponse | ProviderProxySetContainBooleanResponse,
    { kind: 'contained' | 'abandoned' | 'unattributable-group-abandoned' }
  >['claimDischarge'],
): string {
  switch (discharge.kind) {
    case 'completed':
      return 'Every durable claim was accepted by its successor and the set representation was released.';
    case 'initial-disposition-pending':
      return `Claim discharge has not reached an initial disposition; Coral still represents the set until ${discharge.exit}.`;
    case 'initial-disposition-retry-owned':
      return 'Claim discharge has not reached an initial disposition; the coordinator still owns retry and still represents the set.';
    case 'released-undischarged':
      return discharge.witness === 'provider-operation-record'
        ? 'Claim discharge did not complete within the representation-release settlement bound; Coral released the set representation, and the provider-operation records it left behind are retried by the coordinator that is still running.'
        : 'Claim discharge did not complete within the representation-release settlement bound; Coral released the set representation, and the handoff capsule it left behind is reclaimed at the next coordinator start.';
    case 'operational-retry-owned':
      return 'exit' in discharge
        ? `Claim discharge is retry-owned for ${discharge.incidents.length} incident(s) with exit=${discharge.exit}; Coral still represents the set until every successor accepts and capsule retirement completes.`
        : `Claim discharge is retry-owned for ${discharge.incidents.length} incident(s); the coordinator still represents the set until every successor accepts and capsule retirement completes.`;
    default:
      return assertNever(discharge);
  }
}

export function formatProviderProxySetContainResult(
  result: ProviderProxySetContainResponse | ProviderProxySetContainBooleanResponse,
): string {
  const token = encodeProviderProxySetAddress(result.setIdentity);
  const retry = formatBackendOperatorCommand({ kind: 'provider-proxy-set-contain', token });
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
        : result.effect.representationAction === 'abandonment-release-started'
          ? 'Coral started operator-abandonment representation release'
          : 'the coordinator accepted the fatal representation-release remainder',
  ].join('; ');
  switch (result.kind) {
    case 'contained':
      return [
        `Provider proxy set ${token} was contained.`,
        'Observed: guardian=absent, reaper=absent, and the recorded proxy process group plus every recorded provider root are absent.',
        "Not observed: processes outside this set's recorded proxy group and provider-root records.",
        `Effect: ${effect}.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'Next step: inspect backend status.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'abandoned':
      return [
        `Provider proxy set ${token} was abandoned without absence proof.`,
        `Observed: ${observations(result.enforcerObservations)}.`,
        'Not observed: absence of the proxy process group and recorded provider roots; guardian and reaper were not signalled.',
        `Effect: ${effect}.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'Next step: inspect backend status, then verify the proxy, guardian, reaper, and provider processes externally.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'unattributable-group-abandoned':
      return [
        `Provider proxy set ${token} was abandoned after its recorded process group became unattributable.`,
        'Observed: the recorded leader identity is gone.',
        'Not observed: absence of the process group or proof that its numeric group id still belongs to this set.',
        `Effect: ${effect}.`,
        formatProviderProxySetClaimDischarge(result.claimDischarge),
        'Next step: inspect backend status, then verify the proxy and provider processes externally.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'representation-release-abandoned':
      return [
        `Provider proxy set ${token}'s fatal representation release was abandoned.`,
        `Observed: the ${result.successor.owner} accepted the unresolved representation-release remainder.`,
        'Not observed: successful delivery or capsule retirement; the fatal operation was not retried.',
        `Effect: ${effect}.`,
        'Next step: inspect backend status.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'representation-release-abandonment-required':
      return [
        `Provider proxy set ${token} has a fatal representation release that containment cannot finish.`,
        'Observed: the fatal settlement completed with operator acceptance still pending.',
        'Not observed: successful delivery or capsule retirement.',
        `Effect: ${effect}.`,
        'Next step: run the abandon command below.',
        formatBackendOperatorCommand({ kind: 'provider-proxy-set-abandon', token }),
      ].join('\n');
    case 'set-not-found':
      return [
        `Provider proxy set ${token} is not represented by this coordinator.`,
        'Observed: the exact set address has no coordinator representation.',
        'Not observed: enforcer state or recorded-target state.',
        `Effect: ${effect}.`,
        'Next step: inspect backend status and copy the current exact token.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'not-held':
      return [
        `Refusing forced containment for ${token}: the set is ${result.state}, not an operator-exit hold.`,
        `Observed: coordinator lifecycle state=${result.state}.`,
        'Not observed: enforcer state or recorded-target state.',
        `Effect: ${effect}.`,
        formatProviderProxySetNotHeldNextStep(result.state),
      ].join('\n');
    case 'deadline-pending':
      return [
        `Refusing forced containment for ${token}: its monotonic operator-exit gate has ${Math.ceil(result.remainingMs)}ms remaining.`,
        `Observed: the exact set remains held before its state-specific gate.`,
        'Not observed: enforcer state or recorded-target state.',
        `Effect: ${effect}.`,
        'Next step: wait for the gate, then run the contain command below.',
        retry,
      ].join('\n');
    case 'authorization-stale':
      return [
        `The operator-exit authorization for ${token} became stale.`,
        result.effect.containmentAbsent
          ? 'Observed: the recorded containment reached confirmed absence before the attempt changed.'
          : 'Observed: the held attempt changed before containment absence was confirmed.',
        "Not observed: the current held attempt's enforcer and recorded-target state.",
        `Effect: ${effect}.`,
        'Next step: inspect backend status, then run the contain command below only if the same set remains held.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
        retry,
      ].join('\n');
    case 'enforcer-alive':
      return [
        `Refusing to signal ${token}: an enforcer was observed alive.`,
        `Observed: ${observations(result.enforcerObservations)}.`,
        'Not observed: absence of the proxy process group and recorded provider roots.',
        `Effect: ${effect}.`,
        formatProviderProxySetOperatorRefusalGuidance(result.kind, token),
      ].join('\n');
    case 'enforcer-unobservable':
      return [
        `No containment verdict for ${token}: an enforcer was unobservable.`,
        `Observed: ${observations(result.enforcerObservations)}.`,
        'Not observed: absence of both enforcers or of the recorded containment.',
        `Effect: ${effect}.`,
        formatProviderProxySetOperatorRefusalGuidance(result.kind, token),
      ].join('\n');
    case 'recorded-group-unattributable':
      return [
        `No containment verdict for ${token}: the recorded leader identity is gone, and the process group is alive or unobservable but cannot be proven to belong to this set.`,
        'Observed: the pid no longer identifies the recorded process-group leader.',
        'Not observed: absence of the recorded process group or authority to signal its numeric group id.',
        `Effect: ${effect}.`,
        formatProviderProxySetOperatorRefusalGuidance(result.kind, token),
      ].join('\n');
    case 'signal-authorization-refused':
      return [
        `No containment verdict for ${token}: signal authorization was refused for an observed-live recorded target.`,
        'Observed: the containment was attributable and at least one recorded target was present before signal authorization.',
        'Not observed: absence of every recorded target or authority to signal every target still present at delivery.',
        `Effect: ${effect}.`,
        formatProviderProxySetOperatorRefusalGuidance(result.kind, token),
      ].join('\n');
    case 'identity-unobservable':
      return [
        `Refusing to signal ${token}: process identity could not be observed.`,
        'Observed: identity observation became unavailable before Coral delivered any process signal.',
        'Not observed: whether the recorded proxy process group and every recorded provider root still identify this set.',
        `Effect: ${effect}.`,
        formatProviderProxySetOperatorRefusalGuidance(result.kind, token),
      ].join('\n');
    case 'store-unreadable':
      return [
        `Refusing forced containment for ${token}: an unreadable durable provider-operation row may hide a provider root.`,
        'Observed: the durable provider-operation scan contains an unreadable row attributable to this set.',
        'Not observed: enforcer state and the complete recorded target set were not established.',
        `Effect: ${effect}. The abandon command cannot override this store fence.`,
        formatProviderProxySetOperatorRefusalGuidance(result.kind, token),
      ].join('\n');
    case 'containment-unconfirmed':
      return [
        `No containment verdict for ${token}: recorded-containment reaping did not confirm absence.`,
        'Observed: the recorded-containment attempt ended without absence proof.',
        'Not observed: absence of the recorded proxy process group and every recorded provider root.',
        `Effect: ${effect}.`,
        'Next step: run the contain command below.',
        retry,
      ].join('\n');
    default:
      return assertNever(result);
  }
}

function formatProviderProxySetNotHeldNextStep(state: ProviderProxySetLifecycleState): string {
  switch (state) {
    case 'available':
    case 'draining':
      return [
        'Next step: use ordinary drain, or inspect backend status without forcing this set.',
        formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'acquiring':
      return [
        'Next step: let acquisition finish, then inspect backend status.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'capsule-recovering':
    case 'recovering':
      return [
        'Next step: let recovery finish, then inspect backend status.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'absence-delivery-pending':
    case 'abandonment-delivery-pending':
      return [
        'Next step: let successor delivery finish, then inspect backend status.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'capsule-foreign':
      return [
        'Next step: inspect backend status and use the Coral build that owns the foreign capsule.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'reattaching':
    case 'reattachment-hold':
    case 'containing':
    case 'containment-wait':
      return [
        'Next step: inspect backend status, copy its current exact token, and retry only after the reported gate.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
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
        "Handoff hold: retry; if stdout still does not drain, preserve the output and inspect the invoking process's stdout consumer.",
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
      return basis.cause === 'health-shape-rejected'
        ? [
            `Handoff: continuing current build — the incumbent coordinator could not be resolved because ${formatUnresolvedIncumbentCause(basis.cause)}.`,
            'Handoff hold: run the shutdown command below, then run any mutating Coral command (or start a Claude Code session); it attempts startup or handoff from the current installation.',
            formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
          ].join('\n')
        : [
            `Handoff: continuing current build — the incumbent coordinator could not be resolved because ${formatUnresolvedIncumbentCause(basis.cause)}.`,
            'Handoff hold: follow the daemon-status remediation above; do not proceed while the backend status command exits 75.',
          ].join('\n');
    case 'incumbent-unusable':
      return formatUnusableIncumbent(basis);
    case 'invoking-identity-unavailable':
      return [
        `Handoff: continuing current build — ${formatInvokingIdentityFailure(basis.failure)}.`,
        'Handoff hold: repair or reinstall this Coral bundle, then retry.',
      ].join('\n');
    case 'incumbent-identity-unavailable':
      return [
        `Handoff: continuing current build — incumbent ${basis.incumbent.version} did not report a complete bundle identity.`,
        'Handoff hold: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
        formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
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
  const nextStep = [
    'Handoff hold: run the shutdown command below, then rerun a mutating command; it attempts startup or handoff from this installation.',
    formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
  ].join('\n');
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
        'Handoff hold: wait for backend shutdown to finish, then retry.',
      ].join('\n');
    case 'identity-mismatch':
      return [
        'Handoff: continuing current build — the authenticated coordinator identity does not match its discovery record.',
        'Handoff hold: run the shutdown command below, wait for shutdown to finish, then retry.',
        formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
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
    `Handoff hold: repair or reinstall the Coral installation at ${basis.evidence.bundleDir}, then retry.`,
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
const SHUTDOWN_RETRY_NEXT_STEP = [
  'Next step: inspect backend status, then retry the shutdown.',
  formatBackendOperatorCommand({ kind: 'backend-status' }),
].join('\n');
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

function withShutdownRemainderSection(base: string, shutdownRemainder: ShutdownRemainderReport | undefined): string {
  const section = formatShutdownRemainderReport(shutdownRemainder);
  return section.length === 0 ? base : [base, section].join('\n');
}

function formatDaemonStatus(result: BackendStatusFull): string {
  switch (result.status) {
    case 'ok':
      return withShutdownRemainderSection(formatRunningStatus(result.health), result.shutdownRemainder);
    case 'no_record_no_socket':
      return withShutdownRemainderSection(
        'No coordinator discovery record and no coordinator socket at the current expected address were found. Any mutating Coral command (or a Claude Code session start) attempts startup.',
        result.shutdownRemainder,
      );
    case 'recorded_process_absent':
      return withShutdownRemainderSection(
        `A coordinator discovery record names pid=${result.pid}, and that process was observed absent. The record may be stale while another coordinator holds the socket without having published its own record. Any mutating Coral command (or a Claude Code session start) attempts startup or handoff.`,
        result.shutdownRemainder,
      );
    case 'undecodable_record':
      return withShutdownRemainderSection(formatUndecodableRecordStatus(result), result.shutdownRemainder);
    case 'unreachable':
      return withShutdownRemainderSection(formatUnreachableStatus(result), result.shutdownRemainder);
    case 'no_record_socket_present':
      return withShutdownRemainderSection(formatNoRecordSocketPresentStatus(result), result.shutdownRemainder);
    case 'recent_failure':
      return withShutdownRemainderSection(formatRecentFailureStatus(result), result.shutdownRemainder);
    case 'unauthorized':
      return withShutdownRemainderSection(
        [
          'Backend unauthorized. The discovery record and daemon token disagree. Run the shutdown command below, then retry a mutating Coral command; it attempts startup or handoff with a fresh token.',
          formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
        ].join('\n'),
        result.shutdownRemainder,
      );
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
        'Routing hold: run the resolution command below.',
        formatBackendOperatorCommand({ kind: 'routing-status-resolve', invocationId, forceUnobservable: false }),
      ].join('\n');
    case 'unobservable':
      return liveness.cause === 'deadline-expired'
        ? [
            `Routing invocation ${invocationId}: unresolved; owner observation was unobservable (${liveness.cause}).`,
            selectionEvidence,
            'Routing hold: inspect backend status again; an expired sweep cannot authorize resolution.',
            formatBackendOperatorCommand({ kind: 'backend-status' }),
          ].join('\n')
        : [
            `Routing invocation ${invocationId}: unresolved; owner observation was unobservable (${liveness.cause}).`,
            selectionEvidence,
            'Routing hold: verify the owner externally, then run the forced resolution command below to abandon it.',
            formatBackendOperatorCommand({ kind: 'routing-status-resolve', invocationId, forceUnobservable: true }),
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

const ROUTING_INVOCATION_RENDER_LIMIT = 20;

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
          return [
            `Routing invocation ${status.tombstone.invocationId}: retired (selection-evicted-at-capacity; ${terminalEvidence}).`,
            `Selected routing: ${formatSelectedRoutingDisposition(status.tombstone.selectedDisposition)}.`,
            'Routing hold: run the resolution command below to acknowledge the retained capacity eviction.',
            formatBackendOperatorCommand({
              kind: 'routing-status-resolve',
              invocationId: status.tombstone.invocationId,
              forceUnobservable: false,
            }),
          ].join('\n');
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
        'Routing hold: run the discard command below.',
        formatBackendOperatorCommand({ kind: 'routing-status-discard' }),
      ].join('\n');
    case 'no-generation':
      return [
        'Routing status contains application objects but no generation address.',
        'Routing hold: run the discard command below.',
        formatBackendOperatorCommand({ kind: 'routing-status-discard' }),
      ].join('\n');
    case 'other-generation':
      if (result.kind !== 'foreign-generation') throw new Error('Foreign-generation render policy is invalid.');
      return [
        `Routing status generation ${result.generation} belongs to another address.`,
        'Routing hold: run the discard command below.',
        formatBackendOperatorCommand({ kind: 'routing-status-discard' }),
      ].join('\n');
    case 'other-format':
      return [
        'Routing status has this generation address but a different durable format fingerprint.',
        'Routing hold: run the discard command below.',
        formatBackendOperatorCommand({ kind: 'routing-status-discard' }),
      ].join('\n');
    case 'divergent-schema':
      return [
        'Routing status has this generation address but a divergent schema.',
        'Routing hold: run the discard command below.',
        formatBackendOperatorCommand({ kind: 'routing-status-discard' }),
      ].join('\n');
    case 'damaged':
      if (result.kind !== 'unreadable') throw new Error('Unreadable render policy is invalid.');
      return [
        `Routing status is unreadable (${result.reason}).`,
        'Routing hold: run the discard command below.',
        formatBackendOperatorCommand({ kind: 'routing-status-discard' }),
      ].join('\n');
    case 'could-not-observe':
      if (result.kind !== 'undeterminable') throw new Error('Undeterminable render policy is invalid.');
      return [
        `Routing status could not be read (${result.cause}, errcode ${result.errcode}).`,
        'Routing hold: inspect backend status again without discarding. If this persists, repair the reported storage condition; discard is not permitted because this read did not establish a discardable classification.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'content-dependent': {
      if (result.kind !== 'current') throw new Error('Current render policy is invalid.');
      // A hold may not be withheld, so the cap may only ever drop `history`.
      const holds = result.statuses.filter((status) => handoffRoutingInvocationClassification(status) === 'hold');
      const rendered = result.statuses.length <= ROUTING_INVOCATION_RENDER_LIMIT ? result.statuses : holds;
      const sections = rendered.map(formatRoutingInvocationStatus);
      const collapsed = result.statuses.length - rendered.length;
      if (collapsed > 0) sections.push(`Routing invocations already history, needing no action: ${collapsed}.`);
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
      return [
        'Next step: inspect backend status, then run the routing-status discard command it reports before attempting another resolution.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'undeterminable':
      return [
        'Next step: inspect backend status again without discarding and repair the reported storage condition if it persists; resolution requires a current journal.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
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

export function formatHandoffRoutingResolveResult(result: HandoffRoutingResolveResult): string {
  switch (result.kind) {
    case 'resolved':
      return `Resolved routing invocation ${result.invocationId} (${result.reason}).`;
    case 'acknowledged-capacity-eviction':
      return `Acknowledged capacity eviction for routing invocation ${result.invocationId} (selection sequence ${result.selectionSequence}).`;
    case 'stale':
      return [
        `Routing invocation ${result.invocationId} is stale or no longer retained.`,
        'Next step: inspect backend status again and copy an invocation still shown as unresolved.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'already-terminal':
      return `Routing invocation ${result.invocationId} is already terminal. No resolution is needed.\nNext step: no action is needed.`;
    case 'live-owner':
      return [
        `Refusing to resolve routing invocation ${result.invocationId}: its recorded owner is alive.`,
        'Next step: wait for the owner to finish, then inspect backend status again.',
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'unauthorized-unobservable':
      return result.cause === 'deadline-expired'
        ? [
            `Refusing to resolve routing invocation ${result.invocationId}: the owner sweep deadline expired.`,
            'Next step: inspect backend status again, then run the unforced resolution command below; --force-unobservable cannot override an expired observation budget.',
            formatBackendOperatorCommand({ kind: 'backend-status' }),
            formatBackendOperatorCommand({
              kind: 'routing-status-resolve',
              invocationId: result.invocationId,
              forceUnobservable: false,
            }),
          ].join('\n')
        : [
            `Refusing to resolve routing invocation ${result.invocationId}: owner observation is unobservable (${result.cause}).`,
            'Next step: verify the owner externally, then run the forced resolution command below only if abandoning it is safe.',
            formatBackendOperatorCommand({
              kind: 'routing-status-resolve',
              invocationId: result.invocationId,
              forceUnobservable: true,
            }),
          ].join('\n');
    case 'status-unavailable':
      return `Refusing to resolve routing invocation ${result.invocationId} because the authoritative journal is ${result.status.kind}.\n${formatUnavailableRoutingResolution(result.status)}`;
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

function formatUndecodableRecordStatus(result: Extract<BackendStatusFull, { status: 'undecodable_record' }>): string {
  return [
    `Backend state is unknown: the coordinator discovery record could not be read (${result.reason}).`,
    'A coordinator may still be running; this is not a report that none is.',
    `Next step: no Coral command can stop a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete ${result.path} and run a mutating Coral command; it attempts startup or handoff.`,
  ].join('\n');
}

// Deliberately not "not running": something answered at the recorded address, the address refused a
// connection, the request to it did not complete, or a Coral coordinator that is not this one answered.
// `cause` is what tells them apart, since only a received response proves anything is listening and only a
// refusal proves nothing is.
function formatUnreachableStatus(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  return [
    formatUnreachableHeadline(result),
    formatUnreachableCauseLine(result),
    formatUnreachableNextStep(result),
  ].join('\n');
}

function formatUnreachableHeadline(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  return result.cause === 'foreign_peer'
    ? `Backend state is unknown: the recorded coordinator address is answered by a Coral coordinator for namespace=${result.observed.namespace} flavor=${result.observed.flavor}, which is not the identity the discovery record carries.`
    : `Backend state is unknown: the coordinator did not give a usable answer (${result.detail}).`;
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
    case 'foreign_peer':
      return 'That says only who holds the recorded port, which the operating system reassigns freely: it is not a report that the backend stopped, and it is not a conflict over startup, because this installation is reached through its own socket rather than that port. A mutating Coral command (or a Claude Code session start) still attempts startup or handoff.';
    default:
      return assertNever(result);
  }
}

// A record whose address something else now holds never clears by retrying: it is settled by checking that
// process and deleting the record. The same evidence must reach the operator with the same remedy whichever
// surface observed it.
function checkRecordedProcessThenClear(pid: number, recordPath: string): string {
  return `run 'ps -p ${pid}' (or check your process manager), and if that is not Coral, delete ${recordPath} and run a mutating Coral command; it attempts startup or handoff.`;
}

function formatUnreachableNextStep(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  switch (result.cause) {
    case 'responded':
    case 'no_response':
      return 'Next step: retry, and check the coordinator logs if it persists.';
    case 'refused':
      return `Next step: retry shortly — a drain finishes on its own. If it keeps refusing, the record may name a pid something else now holds: ${checkRecordedProcessThenClear(result.pid, result.recordPath)}`;
    case 'foreign_peer':
      return `Next step: the record names a port that coordinator holds, so it is stale unless the recorded process still owns it: ${checkRecordedProcessThenClear(result.pid, result.recordPath)} The ordinary shutdown command cannot stop the coordinator that answered: it presents the boot token from a record that coordinator never wrote, and is rejected.`;
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
    'Next step: retry shortly — a coordinator mid-boot writes its record within seconds, and how long this persists does not by itself tell a stale socket from one still starting. Run a mutating Coral command (or start a Claude Code session) either way; it attempts startup or handoff. If it reports the backend unreachable, the coordinator log is what says why.',
  ].join('\n');
}

// Shared by every disposition that names a code it could not render text for. "Upgrade Coral" may be said
// only about a record another build wrote: a refusal the running build itself recorded has no later release
// that resolves it, so pointing at one sends the operator after something that does not exist.
function unrenderedSetupErrorNextStep(authorship: SetupErrorAuthorshipKind): string {
  const retry =
    "then retry a mutating Coral command; it attempts startup or handoff. Inspect backend status again to observe that attempt's result.";
  switch (authorship) {
    case 'this-build':
    case 'unprovable':
      return `Next step: inspect the coordinator log for that code, ${retry}`;
    case 'other-build':
      return `Next step: inspect the coordinator log for that code, upgrade Coral, ${retry}`;
    default:
      return assertNever(authorship);
  }
}

// "whose codes this build cannot name" may be said only about a code some other build wrote. A record the
// running build itself wrote and then could not re-read is not evidence that its own catalog is missing
// anything, so that arm may claim only what it observed: the text did not survive the round trip.
function formatUnrecognizedSetupErrorLines(
  setupError: Extract<OperatorFacingCoralSetupError, { kind: 'unrecognized_code' }>,
): readonly string[] {
  const nextStep = unrenderedSetupErrorNextStep(setupError.authorship);
  switch (setupError.authorship) {
    case 'this-build':
      return [
        `Cause: Coral recorded a setup refusal this build wrote, and the text recorded with it could not be re-read. [code=${setupError.code}]`,
        nextStep,
      ];
    case 'other-build':
      return [
        `Cause: Coral recorded a setup refusal from another Coral build, whose codes this build cannot name. [code=${setupError.code}]`,
        nextStep,
      ];
    case 'unprovable':
      return [
        `Cause: Coral recorded a setup refusal and could not prove which Coral build wrote it. [code=${setupError.code}]`,
        nextStep,
      ];
    default:
      return assertNever(setupError.authorship);
  }
}

// This build documents the code, so the operator gets it even though the recorded details could not be
// rendered: the code is what makes the refusal findable in the log and in release notes, and withholding it
// would leave a documented refusal with less to act on than an entirely unknown one.
function formatUnrenderableContextSetupErrorLines(
  setupError: Extract<OperatorFacingCoralSetupError, { kind: 'unrenderable_context' }>,
): readonly string[] {
  return [
    `Cause: Coral documents this setup refusal, but the details recorded with it are not in the shape this build renders that code from, so its text could not be regenerated. [code=${setupError.code}]`,
    unrenderedSetupErrorNextStep(setupError.authorship),
  ];
}

function formatSetupErrorLines(setupError: OperatorFacingCoralSetupError): readonly string[] {
  switch (setupError.kind) {
    case 'documented':
    case 'self_authored':
      return [`Cause: ${setupError.userMessage} [code=${setupError.code}]`, `Next step: ${setupError.remediation}`];
    case 'unrecognized_code':
      return formatUnrecognizedSetupErrorLines(setupError);
    case 'unrenderable_context':
      return formatUnrenderableContextSetupErrorLines(setupError);
    case 'invalid_diagnostic':
      return [
        'Cause: Coral recorded a setup refusal that carries no readable setup-error code.',
        'Next step: inspect the coordinator log, then retry a mutating Coral command so a current valid startup diagnostic replaces this one.',
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
      'Next step: inspect the coordinator log, fix the reported cause, then retry a mutating Coral command; it attempts startup or handoff.',
    );
    return lines.join('\n');
  }
  return [...lines, ...formatSetupErrorLines(result.setupError)].join('\n');
}

function formatShutdownRemainderReport(report: ShutdownRemainderReport | undefined): string {
  const lines =
    report?.status === 'recent_shutdown_remainder' ||
    report?.status === 'stale_shutdown_remainder' ||
    report?.status === 'shutdown_remainder_clock_skew'
      ? formatShutdownRemainderRecord(report)
      : [];
  if (report?.status === 'stale_shutdown_remainder') {
    lines.unshift('Shutdown remainder evidence is older than the trusted recent window.');
  }
  if (report?.status === 'shutdown_remainder_clock_skew') {
    lines.unshift('The shutdown remainder record is dated after this status observation.');
  }
  if (report?.status === 'shutdown_remainder_unreadable') {
    const errno = report.reason === 'unreadable' ? ` errno=${report.errno ?? 'unavailable'}` : '';
    lines.push(
      'A shutdown remainder record is present and this build could not read it; nothing in it identifies which coordinator wrote it.',
      `Unusable: path=${report.path} cause=${report.reason}${errno}`,
    );
  }
  return lines.join('\n');
}

function formatShutdownRemainderRecord(
  result: Extract<
    ShutdownRemainderReport,
    { status: 'recent_shutdown_remainder' | 'stale_shutdown_remainder' | 'shutdown_remainder_clock_skew' }
  >,
): string[] {
  const lines = [
    result.status === 'recent_shutdown_remainder'
      ? 'Coral recorded a recent shutdown with unfinished obligations.'
      : result.status === 'stale_shutdown_remainder'
        ? 'Coral recorded an older shutdown with unfinished obligations.'
        : 'Coral recorded a shutdown with unfinished obligations and an untrusted timestamp.',
    `Instance: ${result.record.instanceId}`,
    `Recorded at: ${result.record.recordedAt}`,
    `Reason: ${result.record.reason}`,
    `Mode: ${result.record.mode}`,
  ];
  for (const entry of result.record.entries) {
    lines.push(
      `Entry ${entry.entryNumber}: ${formatShutdownObligation(entry.obligation)}`,
      `  Owner: ${entry.remainder.owner}`,
      ...formatShutdownSettlementLines(entry.settlement),
      ...formatShutdownRemainderEvidenceLines(entry.remainder),
    );
  }
  lines.push(...formatSkippedShutdownRemainderEntries(result.skippedEntries));
  return lines;
}

function formatShutdownObligation(
  obligation: Extract<
    ShutdownRemainderReport,
    { status: 'recent_shutdown_remainder' }
  >['record']['entries'][number]['obligation'],
): string {
  if (obligation === null) return 'unrecognized obligation';
  switch (obligation.label) {
    case 'stream response close':
      return `${obligation.label} ${obligation.ordinal}`;
    case 'provider proxy lifecycle fatal incident':
      return `${obligation.label}${obligation.occurrence === 1 ? '' : ` ${obligation.occurrence}`}`;
    default:
      return obligation.label;
  }
}

function formatShutdownSettlementLines(
  settlement: Extract<
    ShutdownRemainderReport,
    { status: 'recent_shutdown_remainder' }
  >['record']['entries'][number]['settlement'],
): string[] {
  const lines = [`  Cause: ${settlement.cause}`];
  switch (settlement.cause) {
    case 'rejected':
    case 'aborted':
      return [
        ...lines,
        `  Error: ${settlement.error.name ?? 'unavailable'}`,
        ...(settlement.error.code === undefined ? [] : [`  Code: ${settlement.error.code}`]),
      ];
    case 'timed-out':
      return [...lines, `  Budget: ${settlement.budgetMs}ms`];
    case 'budget-exhausted':
    case 'unconfirmed':
      return lines;
  }
}

function formatShutdownRemainderEvidenceLines(
  remainder: Extract<
    ShutdownRemainderReport,
    { status: 'recent_shutdown_remainder' }
  >['record']['entries'][number]['remainder'],
): string[] {
  if (remainder.owner === 'process-exit') return [];
  if (remainder.evidence.kind !== 'startup-adoption') return [`  Evidence: ${remainder.evidence.kind}`];
  return [
    '  Evidence: startup-adoption',
    ...remainder.evidence.processes.flatMap((process) => [`    Job: ${process.jobId}`, `    PID: ${process.pid}`]),
  ];
}

function formatSkippedShutdownRemainderEntries(
  entries: Extract<ShutdownRemainderReport, { status: 'recent_shutdown_remainder' }>['skippedEntries'],
): string[] {
  return entries.flatMap((entry) => [
    `Skipped entry ${entry.entryNumber}: ${formatShutdownObligation(entry.obligation)}`,
    `  Owner: ${entry.owner ?? 'unavailable'}`,
  ]);
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
        'Next step: return to the top-level Coral session and run the shutdown command below there.',
        formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
      ].join('\n');
    case 'capability_rejected':
      return formatCapabilityRejected(result);
    case 'no_record_socket_present':
      return formatNoRecordSocketPresentShutdown();
    default:
      return assertNever(result);
  }
}

function formatUnreadableRecordShutdown(detail: string): string {
  return [
    `Shutdown not attempted: the coordinator discovery record could not be read (${detail}).`,
    'A coordinator may still be running; this is not confirmation that one stopped.',
    'Next step: no Coral command can dial a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete the record file (backend status reports its path) and run a mutating Coral command; it attempts startup or handoff.',
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
    // state forever and the two commands loop. Only a bind clears a stale socket, and no read command binds.
    'Next step: retry shortly in case a coordinator is mid-boot — how long this persists does not by itself tell a stale socket from one still starting. Run a mutating Coral command (or start a Claude Code session) either way; it attempts startup or handoff, and starting up is what clears a stale socket. If it instead reports the backend unreachable, the coordinator log is what says why. Once a coordinator is serving, retry the shutdown.',
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
    `Next step: retry shortly — a drain finishes on its own. If it keeps refusing, the record may name a pid something else now holds: ${checkRecordedProcessThenClear(result.pid, result.recordPath)}`,
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
    'Next step: inspect backend status to see which build is answering; if it is not this one, shut it down from its own install, or confirm with your process manager that the recorded pid is still the process serving that address before stopping it directly.',
    formatBackendOperatorCommand({ kind: 'backend-status' }),
  ].join('\n');
}

export type RecoveryQuarantineListResult =
  | readonly RecoveryQuarantineListEntry[]
  | Readonly<{ kind: 'unavailable'; reason: 'unobservable' }>;

export function formatRecoveryQuarantineList(result: RecoveryQuarantineListResult): string {
  if (!Array.isArray(result)) {
    return 'Recovery quarantine inspection is unavailable because the current store could not be observed safely; no rows were read.';
  }
  const entries = result as readonly RecoveryQuarantineListEntry[];
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
    const isClearable =
      entry.state === 'active' &&
      entry.retry === null &&
      entry.continuation === null &&
      entry.detectedAt !== null &&
      entry.updatedAt !== null;
    const remedyProvidesClear =
      entry.remedy?.kind === 'recovery-quarantine-clear' && entry.remedy.command.kind === 'clear';
    if (isClearable && !remedyProvidesClear) {
      lines.push(
        `  ${formatRecoveryQuarantineCommand(
          {
            kind: 'clear',
            boundary: entry.boundary,
            key: entry.subject.key,
            revision: formatRecoveryRevision(entry),
          },
          'clear',
        )}`,
      );
    }
    if (entry.remedy !== null && recoveryRecordRemedyMatchesEntry(entry.remedy, entry, isClearable)) {
      lines.push(
        ...formatRecoveryRecordRemedy(entry.remedy)
          .split('\n')
          .map((line) => `  ${line}`),
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
      return [
        `Recovery retry failed again; the subject is still quarantined: ${coordinate}. Inspect the updated error:`,
        formatRecoveryQuarantineCommand({ kind: 'list' }),
      ].join('\n');
    case 'continuation':
      return [
        `Recovery retry made partial progress: ${coordinate}. Do not run clear again with this coordinate; inspect the durable continuation:`,
        formatRecoveryQuarantineCommand({ kind: 'list' }),
      ].join('\n');
    default:
      return assertNever(result.disposition);
  }
}

export function formatUnreadableProviderOperationDiscard(result: UnreadableProviderOperationDiscardResult): string {
  const coordinate = `key=${encodeRecoveryQuarantineKey(result.key)} revision=${JSON.stringify(
    `${RECOVERY_REVISION_FINGERPRINT_PREFIX}${result.revision}`,
  )}`;
  switch (result.kind) {
    case 'recovery-in-progress':
      return [
        `Refusing discard for ${coordinate} [${result.code}]: ${result.message}`,
        'Observed: startup recovery still owns the coordinator launch fence.',
        'Not observed: raw-row contents or an operation-settlement outcome.',
        'Effect: the raw row, due pointers, quarantine evidence, startup permit, and launch capacity were not changed.',
        'Next step: wait for startup recovery to finish, then retry with the complete command below.',
        formatProviderOperationRemedy(result.remedy),
      ].join('\n');
    case 'discarded':
      return [
        `Discarded unreadable provider-operation row ${coordinate}.`,
        'Observed: the exact raw-row coordinate was still unreadable and the transactional discard completed.',
        'Not observed: process state or an operation-settlement outcome.',
        'Effect: the exact raw operation record, every known-generation due pointer to it, and its quarantine evidence were permanently removed in one transaction; no process was signalled and the operation was not settled.',
        'Next step: inspect the recovery quarantine, then inspect backend status.',
        formatRecoveryQuarantineCommand({ kind: 'list' }),
        formatBackendOperatorCommand({ kind: 'backend-status' }),
      ].join('\n');
    case 'adoption-refused':
      return [
        `Provider-operation startup ownership remains unresolved after the raw row was ${result.rowDisposition}: ${coordinate}.`,
        `Observed: ${result.releasedLaunchPermits} launch permit(s) were released, but ${result.refusals.length} surviving readable record(s) were not adopted.`,
        'Not observed: reconciliation or an operation-settlement outcome for the refused records.',
        'Effect: the refused records remain unadopted and their launch capacity remains held.',
        ...result.refusals.map(
          (refusal) =>
            `Refusal: record=${encodeRecoveryQuarantineKey(refusal.recordKey)} job=${refusal.jobId} operation=${refusal.operationId} proxy=${refusal.proxyInstanceId} buildSet=${refusal.buildSetId} reason=${refusal.reason}`,
        ),
        ...result.refusals.map((refusal) => formatProviderOperationAdoptionRefusalNextStep(refusal, 'Next step')),
      ].join('\n');
    case 'absent':
      return [
        `Refusing discard for ${coordinate}: the raw row is absent.`,
        'Observed: the exact raw-row key was absent after the quarantine subject was claimed.',
        'Not observed: process state or an operation-settlement outcome.',
        'Effect: nothing was removed and the temporary discard claim was released.',
        'Next step: inspect the recovery quarantine.',
        formatRecoveryQuarantineCommand({ kind: 'list' }),
      ].join('\n');
    case 'readable':
      return [
        `Refusing discard for ${coordinate}: this build can now read the row.`,
        'Observed: the exact raw row decoded under this build.',
        'Not observed: process state or an operation-settlement outcome.',
        'Effect: nothing was removed and the temporary discard claim was released.',
        'Next step: retry the readable row through the complete clear remedy below.',
        formatProviderOperationRemedy({
          kind: 'recovery-quarantine-clear',
          command: {
            kind: 'clear',
            boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
            key: result.key,
            revision: `${RECOVERY_REVISION_FINGERPRINT_PREFIX}${result.revision}`,
          },
        }),
      ].join('\n');
    case 'revision-mismatch':
      return [
        `Refusing discard for ${coordinate}: the exact recovery coordinate now has revision ${JSON.stringify(`${RECOVERY_REVISION_FINGERPRINT_PREFIX}${result.currentRevision}`)}.`,
        'Observed: either the persisted quarantine subject or the raw row carries a different fingerprint.',
        'Not observed: which persisted source changed; the result reports only the current authority fingerprint.',
        'Effect: nothing was removed and any temporary discard claim was released.',
        'Next step: inspect the recovery quarantine and use the new exact revision.',
        formatRecoveryQuarantineCommand({ kind: 'list' }),
      ].join('\n');
    case 'quarantine-not-found':
      return [
        `No discard verdict for ${coordinate}: the exact persisted quarantine subject is absent.`,
        'Observed: no persisted quarantine subject authorizes this exact coordinate.',
        'Not observed: the raw row contents, because no discard authority was established.',
        'Effect: the raw row and due pointers were not changed.',
        'Next step: start or repair the canonical coordinator, then inspect the recovery quarantine and use only a currently printed discard command.',
        formatRecoveryQuarantineCommand({ kind: 'list' }),
      ].join('\n');
    case 'owned':
      return [
        `No discard verdict for ${coordinate}: recovery currently owns the exact quarantine subject in state ${result.state}.`,
        `Observed: the exact quarantine subject is ${result.state} under another recovery owner.`,
        'Not observed: the raw row contents, because another recovery owner retains authority.',
        'Effect: the raw row, due pointers, and quarantine evidence were not changed.',
        'Next step: let that recovery owner finish, then inspect the recovery quarantine before deciding whether to retry.',
        formatRecoveryQuarantineCommand({ kind: 'list' }),
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
type ProviderProxySetStatus = NonNullable<NonNullable<BackendHealth['diagnostics']>['providerProxySets']>[number];
type LaunchPermitStatus = NonNullable<NonNullable<BackendHealth['diagnostics']>['launchPermits']>[number];
type LaunchReleaseDispositionStatus = NonNullable<
  NonNullable<BackendHealth['diagnostics']>['launchReleaseDispositions']
>[number];
type LaunchReclamationStatus = NonNullable<NonNullable<BackendHealth['diagnostics']>['launchReclamations']>[number];
type ProviderOperationAdoptionRefusalStatus = NonNullable<
  NonNullable<BackendHealth['diagnostics']>['providerOperationAdoptionRefusals']
>[number];
type SettlementRefusalRecordingFailureStatus = NonNullable<
  NonNullable<BackendHealth['diagnostics']>['settlementRefusalRecordingFailures']
>[number];

function formatLaunchPermitHolder(holder: LaunchPermitStatus['holder']): string {
  switch (holder.kind) {
    case 'local-execution':
    case 'recovery':
    case 'queue-handoff':
      return holder.kind;
    case 'system-task':
      return `${holder.kind}:${holder.id}`;
    case 'proxy-operation':
      return `${holder.kind}:${holder.operationId}`;
    case 'undecided-provider-operation':
      return `${holder.kind}:${JSON.stringify(holder.recordKeys)}`;
    default:
      return assertNever(holder);
  }
}

function formatLaunchExecutionOwner(owner: LaunchPermitStatus['executionOwner']): string {
  switch (owner.kind) {
    case 'provider-session':
    case 'workflow':
    case 'discussion':
    case 'system-task':
      return `${owner.kind}:${owner.id}`;
    default:
      return assertNever(owner);
  }
}

function formatLaunchReleaseDisposition(disposition: LaunchReleaseDispositionStatus['disposition']): string {
  switch (disposition.kind) {
    case 'already-released':
      return `${disposition.kind} pool=${disposition.pool}`;
    case 'transferred':
      return `${disposition.kind} pool=${disposition.pool} holder=${formatLaunchPermitHolder(disposition.holder)}`;
    default:
      return assertNever(disposition);
  }
}

function formatLaunchReclamationEvidence(evidence: LaunchReclamationStatus['evidence']): string {
  switch (evidence.kind) {
    case 'job-absent':
      return evidence.kind;
    case 'job-terminal':
      return `${evidence.kind}:${evidence.phase}`;
    case 'provider-operation-absent':
      return (
        `${evidence.kind}:${evidence.operationId} ` +
        `jobEvidence=${formatLaunchReclamationEvidence(evidence.jobEvidence)}`
      );
    case 'provider-operation-records-absent':
      return (
        `${evidence.kind}:${JSON.stringify(evidence.recordKeys)} ` +
        `jobEvidence=${formatLaunchReclamationEvidence(evidence.jobEvidence)}`
      );
    default:
      return assertNever(evidence);
  }
}

function formatProviderOperationAdoptionRefusalNextStep(
  refusal: Pick<ProviderOperationAdoptionRefusalStatus, 'jobId' | 'recordKey' | 'remedy'>,
  leadLabel: 'Diagnostic hold' | 'Next step',
): string {
  const inspect = formatBackendOperatorCommand({ kind: 'jobs-detail', jobId: refusal.jobId });
  const status = formatBackendOperatorCommand({ kind: 'backend-status' });
  switch (refusal.remedy.kind) {
    case 'restart-coordinator':
      return [
        `${leadLabel}: for record=${refusal.recordKey}, restart or repair the canonical coordinator externally; Coral retries adoption during startup. Then inspect the job and backend status.`,
        inspect,
        status,
      ].join('\n');
    case 'remote-settlement':
      return [
        `${leadLabel}: for record=${refusal.recordKey}, Coral retries the remote settlement path automatically. Then inspect the job and backend status.`,
        inspect,
        status,
      ].join('\n');
    case 'recovery-quarantine-discard': {
      return [
        `${leadLabel} for record=${refusal.recordKey}: follow the complete recovery remedy below.`,
        formatRecoveryRecordRemedy(refusal.remedy),
        'Then inspect the job and backend status.',
        inspect,
        status,
      ].join('\n');
    }
    case 'recovery-quarantine-clear':
      return [
        `${leadLabel} for record=${refusal.recordKey}: follow the complete recovery remedy below.`,
        formatProviderOperationRemedy(refusal.remedy),
        'Then inspect the job and backend status.',
        inspect,
        status,
      ].join('\n');
    case 'external-repair':
      return [
        `${leadLabel}: for record=${refusal.recordKey}, external repair of the reported provider-operation ownership path is required; no Coral command can repair it. Restart the coordinator after repair, then inspect the job and backend status.`,
        inspect,
        status,
      ].join('\n');
  }
}

function formatSettlementRefusalRecordingFailureNextStep(failure: SettlementRefusalRecordingFailureStatus): string {
  const inspect = formatBackendOperatorCommand({ kind: 'jobs-detail', jobId: failure.jobId });
  const status = formatBackendOperatorCommand({ kind: 'backend-status' });
  switch (failure.cause) {
    case 'terminal-persist-failed':
      return [
        '    hold=repair the job store externally; Coral cannot retry because the recovery record was not persisted. Then inspect the job and backend status.',
        `    ${inspect}`,
        `    ${status}`,
      ].join('\n');
    case 'claim-release-failed':
      return [
        '    hold=repair session persistence externally; Coral cannot retry because the recovery record was not persisted. Then inspect the job and backend status.',
        `    ${inspect}`,
        `    ${status}`,
      ].join('\n');
    case 'claim-already-reassigned':
      return [
        '    hold=no automatic retry applies because the session claim belongs to another job. Inspect the job, verify the current session owner externally, then inspect backend status.',
        `    ${inspect}`,
        `    ${status}`,
      ].join('\n');
    case 'settled-unbound-status-persist-failed':
      return [
        `    hold=Coral retries this settlement-status write automatically. Inspect backend status to confirm that job=${failure.jobId} operation=${failure.operationId} is no longer listed.`,
        `    ${status}`,
      ].join('\n');
    default:
      return assertNever(failure);
  }
}

export function formatProviderProxySetAutonomousDisposition(set: ProviderProxySetStatus): string {
  const disposition = set.autonomousDisposition;
  switch (disposition.kind) {
    case 'inactive':
      return `disposition=inactive waitingFor=${[...new Set(set.holds.map(({ waitingFor }) => waitingFor))].join(',')}`;
    case 'unavailable':
      return 'disposition=unavailable';
    case 'representation-release':
    case 'representation-release-fatal':
    case 'control-or-containment':
    case 'exact-containment':
    case 'durable-reconciliation':
    case 'publication-recovery':
      return `disposition=automatic owner=${disposition.owner} boundMs=${Math.ceil(disposition.boundMs)} retryAction=${disposition.retryAction} refusalSuccessor=${disposition.refusalSuccessor} terminalExit=${disposition.terminalExit}`;
    default:
      return assertNever(disposition);
  }
}

function formatProviderProxySetRowSkip(skip: ProviderProxySetRowSkip): string {
  const token = skip.setToken === null ? '' : ` rawSetToken=${JSON.stringify(skip.setToken)}`;
  const identity =
    skip.setIdentity === null
      ? ''
      : ` rawSetIdentity buildSetId=${JSON.stringify(skip.setIdentity.buildSetId)} hostFingerprint=${JSON.stringify(skip.setIdentity.hostFingerprint)} proxyInstanceId=${JSON.stringify(skip.setIdentity.proxyInstanceId)}`;
  if (token.length === 0 && identity.length === 0) {
    return `skipped row is structurally unidentifiable reason=${skip.reason}; the wire row contains neither a raw set token nor a complete set identity`;
  }
  return `skipped candidate reason=${skip.reason}${token}${identity}`;
}

export function formatProviderProxySetRowSkips(
  skippedRows: number,
  skippedTokens: readonly string[],
  rowSkips: readonly ProviderProxySetRowSkip[] | undefined,
): string[] {
  if (rowSkips !== undefined) {
    const lines = rowSkips.map(formatProviderProxySetRowSkip);
    if (rowSkips.length < skippedRows) {
      lines.push(
        `structurally unidentifiable skipped rows=${skippedRows - rowSkips.length}; no raw set token or complete set identity was preserved`,
      );
    }
    return lines;
  }

  const lines = skippedTokens.map((token) => `skipped candidate rawSetToken=${JSON.stringify(token)}`);
  if (skippedTokens.length < skippedRows) {
    lines.push(
      `structurally unidentifiable skipped rows=${skippedRows - skippedTokens.length}; no raw set token or complete set identity was preserved`,
    );
  }
  return lines;
}

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
  const launchPermits = health.diagnostics?.launchPermits ?? [];
  if (launchPermits.length > 0) {
    lines.push('', 'Launch permits:');
    for (const permit of launchPermits) {
      lines.push(
        `  reservation=${permit.reservationId} job=${permit.jobId} pool=${permit.pool} provider=${permit.provider} heldForMs=${permit.heldForMs}`,
        `    holder=${formatLaunchPermitHolder(permit.holder)}`,
        `    executionOwner=${formatLaunchExecutionOwner(permit.executionOwner)}`,
      );
    }
  }
  const launchReleaseDispositions = health.diagnostics?.launchReleaseDispositions ?? [];
  if (launchReleaseDispositions.length > 0) {
    lines.push('', 'Launch release dispositions:');
    for (const release of launchReleaseDispositions) {
      lines.push(
        `  reservation=${release.reservationId} job=${release.jobId} pool=${release.pool} provider=${release.provider} observedAtMs=${release.observedAtMs}`,
        `    attemptedHolder=${formatLaunchPermitHolder(release.attemptedHolder)}`,
        `    disposition=${formatLaunchReleaseDisposition(release.disposition)}`,
      );
    }
  }
  const providerOperationAdoptionRefusals = health.diagnostics?.providerOperationAdoptionRefusals ?? [];
  if (providerOperationAdoptionRefusals.length > 0) {
    lines.push('', 'Provider-operation adoption refusals:');
    for (const refusal of providerOperationAdoptionRefusals) {
      lines.push(
        `  record=${refusal.recordKey} job=${refusal.jobId} operation=${refusal.operationId} proxy=${refusal.proxyInstanceId} buildSet=${refusal.buildSetId} observedAtMs=${refusal.observedAtMs}`,
        `    triggerRecord=${refusal.triggerRecordKey} rowDisposition=${refusal.rowDisposition} releasedLaunchPermits=${refusal.releasedLaunchPermits}`,
        `    reason=${refusal.reason}`,
        `    ${formatProviderOperationAdoptionRefusalNextStep(refusal, 'Diagnostic hold')}`,
      );
    }
  }
  const launchReclamations = health.diagnostics?.launchReclamations ?? [];
  if (launchReclamations.length > 0) {
    lines.push('', 'Automatic launch reclamations:');
    for (const reclamation of launchReclamations) {
      lines.push(
        `  reservation=${reclamation.reservationId} job=${reclamation.jobId} pool=${reclamation.pool} provider=${reclamation.provider} heldForMs=${reclamation.heldForMs} reclaimedAtMs=${reclamation.reclaimedAtMs}`,
        `    holder=${formatLaunchPermitHolder(reclamation.holder)}`,
        `    evidence=${formatLaunchReclamationEvidence(reclamation.evidence)}`,
      );
    }
  }
  const settlementFailures = health.diagnostics?.settlementRefusalRecordingFailures ?? [];
  if (settlementFailures.length > 0) {
    lines.push('', 'Settlement refusal recording failures:');
    for (const failure of settlementFailures) {
      const operation = 'operationId' in failure ? ` operation=${failure.operationId}` : '';
      lines.push(
        `  job=${failure.jobId}${operation} cause=${failure.cause} observedAtMs=${failure.observedAtMs}`,
        `    error=${failure.error}`,
        formatSettlementRefusalRecordingFailureNextStep(failure),
      );
    }
  }
  const providerProxySets = health.diagnostics?.providerProxySets ?? [];
  const durableDispositionSkips = health.diagnostics?.providerProxyDispositionSkips ?? [];
  const skippedProviderProxySetRows = health.skippedProviderProxySetRows;
  if (providerProxySets.length > 0 || skippedProviderProxySetRows > 0 || durableDispositionSkips.length > 0) {
    lines.push('', 'Provider proxy sets:');
    for (const set of providerProxySets) {
      lines.push(
        `  set=${set.setToken} liveClaims=${set.liveClaims ?? 'unknown'}`,
        `    identity buildSetId=${set.setIdentity.buildSetId} proxyInstanceId=${set.setIdentity.proxyInstanceId} hostFingerprint=${set.setIdentity.hostFingerprint}`,
      );
      for (const incident of set.holds) {
        const subject = [incident.role, incident.method].filter((value) => value !== undefined).join(' ');
        const reattachment =
          incident.cause === undefined
            ? ''
            : ` cause=${incident.cause} attempts=${incident.attempts ?? 'unknown'} elapsedMs=${incident.elapsedMs ?? 'unknown'} boundMs=${incident.boundMs ?? 'unknown'}`;
        const durable =
          incident.durableObservation === undefined
            ? ''
            : incident.durableObservation.kind === 'successor-observed'
              ? ` durable=${incident.durableObservation.kind} writer=${incident.durableObservation.writerIncarnation} observedBy=${incident.durableObservation.observedByIncarnation}`
              : incident.durableObservation.kind === 'stale'
                ? ` durable=${incident.durableObservation.kind} writer=${incident.durableObservation.writerIncarnation} reobserve=${incident.durableObservation.reobserveAction}`
                : ` durable=${incident.durableObservation.kind} writer=${incident.durableObservation.writerIncarnation}`;
        lines.push(
          `    - disposition=${incident.disposition}${subject.length === 0 ? '' : ` subject=${subject}`} incident=${incident.incidentReason} waitingFor=${incident.waitingFor}${reattachment}${incident.enforcerObservations === undefined ? '' : ` enforcers=${incident.enforcerObservations.map(({ role, observation }) => `${role}:${observation}`).join(',')}`}${durable}`,
        );
      }
      lines.push(`    ${formatProviderProxySetAutonomousDisposition(set)}`);
    }
    if (skippedProviderProxySetRows > 0) {
      lines.push(
        `  Provider proxy set rows this build could not read: ${skippedProviderProxySetRows}; backend status is not showing ${skippedProviderProxySetRows === 1 ? 'its disposition, cause, or waiting condition' : 'their dispositions, causes, or waiting conditions'}.`,
      );
      lines.push(
        ...formatProviderProxySetRowSkips(
          skippedProviderProxySetRows,
          health.skippedProviderProxySetTokens,
          health.diagnostics?.providerProxySetRowSkips,
        ).map((skip) => `    ${skip}`),
      );
      lines.push(
        '    No containment or abandonment command is available because this build cannot verify that the backend will authorize it. Inspect backend status from a build that understands the row.',
        `    ${formatBackendOperatorCommand({ kind: 'backend-status' })}`,
      );
    }
    for (const skipped of durableDispositionSkips) {
      lines.push(
        `  Durable provider proxy disposition this build could not read: key=${skipped.key}${skipped.setToken === null ? '' : ` set=${skipped.setToken}`}.`,
        `    Unavailable action: ${skipped.unavailableAction}; this build will neither reconcile nor retire the record. Run backend status from a build that understands the durable record.`,
      );
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
    return [
      'review the failure details above; the reindex command below can rebuild a corrupt KB index',
      formatBackendOperatorCommand({ kind: 'kb-reindex' }),
    ].join('\n');
  }
  return ['restart the daemon with the command below', formatBackendOperatorCommand({ kind: 'backend-shutdown' })].join(
    '\n',
  );
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
      return [
        'free disk space, then run the shutdown command below to reset',
        formatBackendOperatorCommand({ kind: 'backend-shutdown' }),
      ].join('\n');
    case 'recovery-quarantine':
      return [
        'inspect quarantined recovery work with the command below',
        formatRecoveryQuarantineCommand({ kind: 'list' }),
      ].join('\n');
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
