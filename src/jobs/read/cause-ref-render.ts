import type { CoralEvent } from '../../store/envelope.js';
import { continuitySentenceFragment, type SessionContinuityState, type SessionProviderFailureReason } from '../../sessions/fault.js';
import { assertNever } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import { causeRefSchema, type CauseRef } from '../../causality/cause-ref.js';
import {
  describeJobDomainProgress,
  describeJobProgressFault,
  describeLaunchRejected,
  describeTerminalOutcome,
  type TerminalOutcome,
} from '../outcome.js';

export interface CircularCauseRefDiagnostic {
  readonly key: string;
  readonly stream: CauseRef['stream'];
  readonly seq: number;
  readonly path: readonly string[];
}

export interface MissingCauseRefDiagnostic {
  readonly stream: CauseRef['stream'];
  readonly seq: number;
  readonly path: readonly string[];
  readonly terminalOutcome?: TerminalOutcome;
}

export interface CauseRefRenderResult {
  readonly description: string;
  readonly chain: readonly string[];
  readonly cycle?: CircularCauseRefDiagnostic;
  readonly missing?: MissingCauseRefDiagnostic;
}

export interface CauseRefEventStore {
  getEvent(stream: { kind: string; id: string }, seq: number): CoralEvent | undefined;
}

function refKey(ref: CauseRef): string {
  return `${ref.stream.kind}:${ref.stream.id}:${ref.seq}`;
}

function markerForCycle(ref: CauseRef): string {
  return `<cycle detected at ${ref.stream.kind}/${ref.stream.id}/${ref.seq}>`;
}

function markerForMissing(ref: CauseRef): string {
  return `<missing ${ref.stream.kind}/${ref.stream.id}/${ref.seq}>`;
}

function parseCauseRef(value: unknown): CauseRef | null {
  const parsed = causeRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractCauseRef(event: CoralEvent): CauseRef | null {
  if (!isRecord(event.body)) {
    return null;
  }

  const direct = parseCauseRef(event.body.causeRef);
  if (direct) {
    return direct;
  }

  if (!isRecord(event.body.terminal) || !isRecord(event.body.terminal.outcome)) {
    return null;
  }

  return event.body.terminal.outcome.kind === 'failed'
    ? parseCauseRef(event.body.terminal.outcome.causeRef)
    : null;
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// AC2.3: sessions/fault.ts is the canonical authority with exhaustive-switch + assertNever.
// Runtime-injected values are rendered as diagnostics instead of widening the type.
function safeContinuitySentenceFragment(value: SessionContinuityState): string {
  try {
    return continuitySentenceFragment(value);
  } catch {
    return 'continuity unavailable';
  }
}

function describeSessionUnavailable(provider: string, reason: string): string {
  const detail = ensureSentence(reason);
  switch (provider) {
    case 'codex':
      return `Codex session unavailable: ${detail} Start a new Coral session or resume without --session.`;
    case 'claude':
      return `Claude session unavailable: ${detail} Start a new Coral session before forking.`;
    default:
      return `${provider} session unavailable: ${detail}`;
  }
}

function describeEvent(event: CoralEvent): string {
  switch (`${event.stream.kind}:${event.type}`) {
    case 'job:job.launch.requested':
      return 'Job launch requested.';
    case 'job:job.launch.rejected':
      return isRecord(event.body) ? describeLaunchRejected(event.body as Parameters<typeof describeLaunchRejected>[0]) : 'Job launch rejected.';
    case 'job:job.queue.queued':
      return isRecord(event.body) && typeof event.body.queuePosition === 'number'
        ? `Job queued at position ${event.body.queuePosition}.`
        : 'Job queued.';
    case 'job:job.queue.admitted':
      return 'Job admitted for launch.';
    case 'job:job.runtime.started':
      return 'Job runtime started.';
    case 'job:job.progress.emitted':
      if (!isRecord(event.body)) return 'Job progress emitted.';
      if (event.body.kind === 'message' && typeof event.body.message === 'string') return event.body.message;
      if (event.body.kind === 'domain' && typeof event.body.message === 'string') {
        return describeJobDomainProgress(event.body as Parameters<typeof describeJobDomainProgress>[0]);
      }
      return describeJobProgressFault(event.body as Parameters<typeof describeJobProgressFault>[0]);
    case 'job:job.terminal.recorded':
      return isRecord(event.body) && isRecord(event.body.terminal) && isRecord(event.body.terminal.outcome)
        ? describeTerminalOutcome(event.body.terminal.outcome as Parameters<typeof describeTerminalOutcome>[0], {
            describeCauseRef: (ref) => `${ref.stream.kind}/${ref.stream.id}#${ref.seq}`,
          })
        : 'Job terminal recorded.';
    case 'job:job.aborted':
      return isRecord(event.body) && typeof event.body.reason === 'string'
        ? `Job aborted: ${event.body.reason}.`
        : 'Job aborted.';
    case 'session:session.interrupted': {
      if (!isRecord(event.body)) return 'Session interrupted.';
      const continuity =
        typeof event.body.continuity === 'string'
          ? (event.body.continuity as SessionContinuityState)
          : 'unavailable';
      const triggerText =
        event.body.trigger === 'restart'
          ? 'App-server restarted during the turn'
          : 'App-server handoff occurred during the turn';
      return `${triggerText}; ${safeContinuitySentenceFragment(continuity)}.`;
    }
    case 'session:session.provider_failed': {
      if (!isRecord(event.body)) return 'Session provider failed.';
      if (typeof event.body.provider === 'string' && typeof event.body.reason === 'string') {
        const provider = event.body.provider;
        const reason = event.body.reason as SessionProviderFailureReason;
        const message = typeof event.body.message === 'string' ? event.body.message : 'unknown';

        switch (reason) {
          case 'session_unavailable':
            return describeSessionUnavailable(provider, message);
          case 'request_failed':
            return `${provider} turn failed: ${ensureSentence(message)}`;
          default:
            return assertNever(reason);
        }
      }
      return 'Session provider failed.';
    }
    case 'session:session.adapter_unparseable':
      return isRecord(event.body) && typeof event.body.provider === 'string' && typeof event.body.parseError === 'string'
        ? `${event.body.provider} produced unparseable output: ${ensureSentence(event.body.parseError)}`
        : 'Session adapter output could not be parsed.';
    case 'session:session.opened':
      return 'Session opened.';
    case 'session:session.continuity.checkpointed':
      return 'Session continuity checkpointed.';
    case 'session:session.closed':
      return 'Session closed.';
    case 'workflow:workflow.completed':
      if (isRecord(event.body) && typeof event.body.outcome === 'string') {
        return `Workflow ${event.body.outcome}.`;
      }
      return 'Workflow completed.';
    case 'workflow:workflow.plan.declared':
      return 'Workflow plan declared.';
    case 'workflow:workflow.plan.revised':
      return 'Workflow plan revised.';
    case 'workflow:workflow.drain.entered':
      return 'Workflow entered failure drain.';
    default:
      return `${event.type}`;
  }
}

function renderCauseRef(
  ref: CauseRef,
  store: CauseRefEventStore,
  visited: Set<string>,
  path: string[],
  terminalOutcomeDiagnostic?: TerminalOutcome,
): CauseRefRenderResult {
  const key = refKey(ref);
  if (visited.has(key)) {
    return {
      description: markerForCycle(ref),
      chain: [...path, markerForCycle(ref)],
      cycle: {
        key,
        stream: ref.stream,
        seq: ref.seq,
        path,
      },
    };
  }

  visited.add(key);
  const event = store.getEvent(ref.stream, ref.seq);
  if (!event) {
    if (path.length === 0 && terminalOutcomeDiagnostic) {
      const terminalDescription = describeTerminalOutcome(terminalOutcomeDiagnostic);
      const description = `${markerForMissing(ref)} Original terminal outcome: ${terminalDescription}`;
      return {
        description,
        chain: [...path, description],
        missing: {
          stream: ref.stream,
          seq: ref.seq,
          path,
          terminalOutcome: terminalOutcomeDiagnostic,
        },
      };
    }

    return {
      description: markerForMissing(ref),
      chain: [...path, markerForMissing(ref)],
      missing: {
        stream: ref.stream,
        seq: ref.seq,
        path,
      },
    };
  }

  const baseDescription = describeEvent(event);
  const nextRef = extractCauseRef(event);
  if (!nextRef) {
    return {
      description: baseDescription,
      chain: [...path, baseDescription],
    };
  }

  const next = renderCauseRef(nextRef, store, visited, [...path, baseDescription]);
  return {
    description: `${baseDescription} Caused by: ${next.description}`,
    chain: next.chain,
    ...(next.cycle ? { cycle: next.cycle } : {}),
  };
}

export function describeCauseRefDetailed(
  ref: CauseRef,
  store: CauseRefEventStore,
  terminalOutcomeDiagnostic?: TerminalOutcome,
): CauseRefRenderResult {
  return renderCauseRef(ref, store, new Set<string>(), [], terminalOutcomeDiagnostic);
}

export function describeCauseRef(ref: CauseRef, store: CauseRefEventStore, terminalOutcomeDiagnostic?: TerminalOutcome): string {
  return describeCauseRefDetailed(ref, store, terminalOutcomeDiagnostic).description;
}
