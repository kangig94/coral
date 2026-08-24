import type { PublicationOutcome } from '../../coordinator/handoff-routing-status.js';
import type { HandoffPublicationIncident } from '../../coordinator/handoff-runner.js';
import { assertNever } from '../../infra/error-format.js';

type HandoffPublicationFailure = Exclude<PublicationOutcome, { kind: 'committed' }>;

type HandoffRoutingResolutionContext = Readonly<{
  invocationId: string;
}>;

export function formatHandoffPublicationIncident(incident: HandoffPublicationIncident): string {
  switch (incident.kind) {
    case 'refused':
      return [
        `Handoff routing-status ${incident.phase} publication was refused because ${formatHandoffRecordingRefusalDiagnostic(incident.refusal)}.`,
        formatHandoffRecordingRefusalSuccessor(incident.refusal),
      ].join('\n');
    case 'not-published':
      return [
        incident.cause === 'invalid-record'
          ? `Handoff routing-status ${incident.phase} publication was not published (${incident.cause}, ${incident.validation.kind}).`
          : `Handoff routing-status ${incident.phase} publication was not published (${incident.cause}).`,
        formatHandoffPublicationFailureSuccessor(incident),
      ].join('\n');
    case 'undeterminable':
      return [
        `Handoff routing-status ${incident.phase} publication could not be determined ` +
          `(${incident.cause}, errcode ${incident.errcode}).`,
        formatHandoffPublicationFailureSuccessor(incident),
      ].join('\n');
    default:
      return assertNever(incident);
  }
}

function formatHandoffRecordingRefusalDiagnostic(
  refusal: Extract<HandoffPublicationIncident, { kind: 'refused' }>['refusal'],
): string {
  switch (refusal.reason) {
    case 'owner-identity-unavailable':
      return 'this process identity could not be read';
    case 'invalid-target-authority':
      return 'live target authority was unavailable';
    case 'selection-publication-undeterminable':
      return 'selection publication could not be determined';
    default:
      return assertNever(refusal);
  }
}

function formatHandoffRecordingRefusalSuccessor(
  refusal: Extract<HandoffPublicationIncident, { kind: 'refused' }>['refusal'],
): string {
  switch (refusal.reason) {
    case 'owner-identity-unavailable':
      return 'Next step: wait until this process identity is readable, then rerun coral-cli backend status before retrying the operation.';
    case 'invalid-target-authority':
      return 'Next step: wait until live target authority is available, then rerun coral-cli backend status before retrying the operation.';
    case 'selection-publication-undeterminable':
      return 'Next step: run coral-cli backend status before repair and follow the successor it shows for the invocation.';
    default:
      return assertNever(refusal);
  }
}

export function formatHandoffPublicationFailureSuccessor(
  outcome: HandoffPublicationFailure,
  context?: HandoffRoutingResolutionContext,
): string {
  const retryTarget = context === undefined ? 'the operation' : 'this resolve command';
  switch (outcome.kind) {
    case 'not-published': {
      const cause = outcome.cause;
      switch (cause) {
        case 'contended':
          return `Next step: rerun coral-cli backend status, then retry ${retryTarget} if the invocation is still unresolved.`;
        case 'generation-maintenance':
          return `Next step: wait for generation maintenance to finish, rerun coral-cli backend status, then retry ${retryTarget} if the invocation is still unresolved.`;
        case 'capacity-exhausted':
          return `Next step: repair the reported storage-capacity condition, rerun coral-cli backend status, then retry ${retryTarget} if the invocation is still unresolved.`;
        case 'io-failed':
          return `Next step: repair the reported storage condition, rerun coral-cli backend status, then retry ${retryTarget} if the invocation is still unresolved.`;
        case 'unreadable':
        case 'unsupported-generation':
          return `Next step: run coral-cli backend status and follow its routing-status discard successor before retrying ${retryTarget}.`;
        case 'invalid-record':
          return (
            `Next step: report the invalid routing-status record (${outcome.validation.kind}) as a Coral defect; ` +
            'the journal is unaffected, and no storage action is appropriate. After installing corrected Coral software, ' +
            (context === undefined
              ? 'rerun coral-cli backend status.'
              : `rerun coral-cli backend routing-status resolve --invocation ${context.invocationId}.`)
          );
        case 'rejected-transition':
          return `Next step: rerun coral-cli backend status and follow the successor shown for the invocation; do not assume ${context === undefined ? 'publication' : 'resolution'} occurred.`;
        case 'coordination-unavailable':
          return 'Next step: make the generation coordination root writable again, then run coral-cli backend status.';
        default:
          return assertNever(cause);
      }
    }
    case 'undeterminable': {
      const cause = outcome.cause;
      switch (cause) {
        case 'contended':
          return 'Next step: rerun coral-cli backend status before acting; this attempt could not determine whether the contended commit completed.';
        case 'capacity-exhausted':
          return 'Next step: rerun coral-cli backend status before acting and repair the storage-capacity condition; this attempt could not determine whether it committed.';
        case 'io-failed':
          return 'Next step: rerun coral-cli backend status before acting and repair the reported storage condition if it persists; this attempt could not determine whether it committed.';
        case 'unreadable':
          return 'Next step: run coral-cli backend status and follow its routing-status discard successor if the journal is unreadable; this attempt could not determine whether it committed.';
        default:
          return assertNever(cause);
      }
    }
    default:
      return assertNever(outcome);
  }
}
