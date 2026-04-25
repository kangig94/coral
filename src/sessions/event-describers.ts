// Per-event describers for the `session/*` stream. Owned by the sessions
// domain and composed into the default `EventDescriberMap` by
// `read-model/event-describers.ts`.

import type { EventDescriber, EventDescriberMap } from '../causality/render.js';
import { assertNever } from '../infra/error-format.js';
import { isRecord } from '../infra/json.js';
import {
  continuitySentenceFragment,
  type SessionContinuityState,
  type SessionProviderFailureReason,
} from './fault.js';

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// AC2.3: sessions/fault.ts is the canonical authority with exhaustive-switch +
// assertNever. Runtime-injected values are rendered as diagnostics instead of
// widening the type.
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

const opened: EventDescriber = () => 'Session opened.';
const continuityCheckpointed: EventDescriber = () => 'Session continuity checkpointed.';
const closed: EventDescriber = () => 'Session closed.';

const interrupted: EventDescriber = (event) => {
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
};

const providerFailed: EventDescriber = (event) => {
  if (!isRecord(event.body)) return 'Session provider failed.';
  if (typeof event.body.provider !== 'string' || typeof event.body.reason !== 'string') {
    return 'Session provider failed.';
  }
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
};

const adapterUnparseable: EventDescriber = (event) =>
  isRecord(event.body) && typeof event.body.provider === 'string' && typeof event.body.parseError === 'string'
    ? `${event.body.provider} produced unparseable output: ${ensureSentence(event.body.parseError)}`
    : 'Session adapter output could not be parsed.';

export const sessionsEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['session:session.opened', opened],
  ['session:session.continuity.checkpointed', continuityCheckpointed],
  ['session:session.closed', closed],
  ['session:session.interrupted', interrupted],
  ['session:session.provider_failed', providerFailed],
  ['session:session.adapter_unparseable', adapterUnparseable],
]);
