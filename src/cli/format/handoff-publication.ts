import type { PublicationOutcome } from '../../coordinator/handoff-routing/status.js';
import type { HandoffPublicationIncident } from '../../coordinator/handoff-routing/runner.js';
import { assertNever } from '../../infra/error-format.js';

type HandoffPublicationActionContext =
  | Readonly<{
      kind: 'incident';
      incident: HandoffPublicationIncident;
    }>
  | Readonly<{
      kind: 'resolution';
      invocationId: string;
      outcome: Exclude<PublicationOutcome, { kind: 'committed' }>;
    }>;

type HandoffPublicationFailure =
  | Readonly<{
      kind: 'incident';
      incident:
        | Extract<HandoffPublicationIncident, { kind: 'not-published' }>
        | Extract<HandoffPublicationIncident, { kind: 'undeterminable' }>;
    }>
  | Readonly<{
      kind: 'resolution';
      invocationId: string;
      outcome: Exclude<PublicationOutcome, { kind: 'committed' }>;
    }>;

export function formatHandoffPublicationIncident(incident: HandoffPublicationIncident): string {
  switch (incident.kind) {
    case 'refused':
      return [
        `Handoff routing-status ${incident.phase} publication for invocation ${incident.invocationId} was refused because ${formatHandoffRecordingRefusalDiagnostic(incident.refusal)}.`,
        formatHandoffRecordingRefusalSuccessor(incident),
      ].join('\n');
    case 'not-published':
      return [
        incident.cause === 'invalid-record'
          ? `Handoff routing-status ${incident.phase} publication for invocation ${incident.invocationId} was not published (${incident.cause}, ${incident.validation.kind}).`
          : `Handoff routing-status ${incident.phase} publication for invocation ${incident.invocationId} was not published (${incident.cause}).`,
        formatHandoffPublicationFailureSuccessor({ kind: 'incident', incident }),
      ].join('\n');
    case 'undeterminable':
      return [
        `Handoff routing-status ${incident.phase} publication for invocation ${incident.invocationId} could not be determined ` +
          `(${incident.cause}, errcode ${incident.errcode}).`,
        formatHandoffPublicationFailureSuccessor({ kind: 'incident', incident }),
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
  incident: Extract<HandoffPublicationIncident, { kind: 'refused' }>,
): string {
  const { refusal } = incident;
  switch (refusal.reason) {
    case 'owner-identity-unavailable':
      return 'Next step: wait until this process identity is readable, then rerun coral-cli backend status before retrying the operation.';
    case 'invalid-target-authority':
      return 'Next step: wait until live target authority is available, then rerun coral-cli backend status before retrying the operation.';
    case 'selection-publication-undeterminable':
      return `Next step: ${formatPublicationNextAction({ kind: 'incident', incident })}`;
    default:
      return assertNever(refusal);
  }
}

function formatPublicationAfterStatus(input: HandoffPublicationActionContext): string {
  if (input.kind === 'resolution') {
    return (
      `retry coral-cli backend routing-status resolve --invocation ${input.invocationId} if routing invocation ` +
      `${input.invocationId} is still unresolved`
    );
  }
  const { incident } = input;
  if (incident.phase === 'selection') {
    return `retry the operation if routing invocation ${incident.invocationId} is still unresolved`;
  }
  const resolveOpening =
    `if routing invocation ${incident.invocationId} is still unresolved, run coral-cli backend routing-status ` +
    `resolve --invocation ${incident.invocationId}`;
  switch (incident.terminalDisposition.kind) {
    case 'execution-failed':
      return `${resolveOpening}. The operation failed; follow the original error's remediation, then retry it`;
    case 'continued-current':
      return `${resolveOpening}. Routing finished; the local operation is continuing`;
    case 'delegated-success':
      return `${resolveOpening}. The delegated operation succeeded; do not rerun it`;
    case 'delegated-exit':
      return `${resolveOpening}. The delegated child exited with code ${incident.terminalDisposition.exitCode}; follow the child's own diagnosis`;
    case 'delegated-signal':
      return `${resolveOpening}. The delegated child ended from signal ${incident.terminalDisposition.signal}; use the child's output to diagnose the operation`;
    default:
      return assertNever(incident.terminalDisposition);
  }
}

function formatPublicationNextAction(input: HandoffPublicationActionContext): string {
  const afterStatus = formatPublicationAfterStatus(input);
  return input.kind === 'incident' && input.incident.phase === 'terminal'
    ? `rerun coral-cli backend status; ${afterStatus}.`
    : `rerun coral-cli backend status, then ${afterStatus}.`;
}

function publicationAttempt(input: HandoffPublicationFailure): 'publication' | 'resolution' {
  return input.kind === 'incident' ? 'publication' : 'resolution';
}

export function formatHandoffPublicationFailureSuccessor(input: HandoffPublicationFailure): string {
  const outcome = input.kind === 'incident' ? input.incident : input.outcome;
  const nextAction = formatPublicationNextAction(input);
  switch (outcome.kind) {
    case 'not-published': {
      const cause = outcome.cause;
      switch (cause) {
        case 'contended':
          return `Next step: ${nextAction}`;
        case 'generation-maintenance':
          return `Next step: after generation maintenance finishes, ${nextAction} If its holder exited, retry after the maintenance lease has gone ten minutes without a heartbeat; do not delete the lease.`;
        case 'capacity-exhausted':
          return `Next step: repair the reported storage-capacity condition, then ${nextAction}`;
        case 'io-failed':
          return `Next step: repair the reported storage condition, then ${nextAction}`;
        case 'unreadable':
        case 'unsupported-generation':
          return `Next step: run coral-cli backend status and follow its routing-status discard successor, then ${nextAction}`;
        case 'invalid-record':
          return (
            `Next step: report the invalid routing-status record (${outcome.validation.kind}) as a Coral defect; ` +
            'the journal is unaffected, and no storage action is appropriate. After installing corrected Coral software, ' +
            (input.kind === 'resolution'
              ? `rerun coral-cli backend routing-status resolve --invocation ${input.invocationId}.`
              : nextAction)
          );
        case 'rejected-transition':
          return (
            `Next step: rerun coral-cli backend status and follow the successor shown for this invocation; do not ` +
            `assume ${publicationAttempt(input)} occurred. Then ${formatPublicationAfterStatus(input)}.`
          );
        case 'coordination-unavailable':
          return `Next step: make the generation coordination root writable again, then ${nextAction}`;
        default:
          return assertNever(cause);
      }
    }
    case 'undeterminable': {
      const cause = outcome.cause;
      switch (cause) {
        case 'contended':
          return `Next step: ${nextAction} This attempt could not determine whether the contended commit completed.`;
        case 'capacity-exhausted':
          return `Next step: repair the storage-capacity condition, then ${nextAction} This attempt could not determine whether it committed.`;
        case 'io-failed':
          return `Next step: repair the reported storage condition if it persists, then ${nextAction} This attempt could not determine whether it committed.`;
        case 'unreadable':
          return `Next step: run coral-cli backend status and follow its routing-status discard successor if the journal is unreadable, then ${nextAction} This attempt could not determine whether it committed.`;
        default:
          return assertNever(cause);
      }
    }
    default:
      return assertNever(outcome);
  }
}
