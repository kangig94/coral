import { isRecord, readString } from '../../infra/json.js';
import type { AppServerNotificationMessage } from '../protocol.js';
import type { CodexErrorInfo, Turn } from './protocol.js';

const STRING_CODEX_ERRORS = new Set<CodexErrorInfo>([
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'serverOverloaded',
  'cyberPolicy',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
]);

const HTTP_ERROR_TAGS = new Set([
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts',
]);

export type DecodedCodexErrorInfo =
  | { kind: 'none' }
  | { kind: 'known'; value: CodexErrorInfo }
  | { kind: 'unknown'; raw: unknown }
  | { kind: 'invalid'; raw: unknown };

export type DecodedTurnError =
  | { kind: 'absent' }
  | {
      kind: 'known' | 'unknown' | 'invalid';
      message: string | undefined;
      info: DecodedCodexErrorInfo;
      raw: unknown;
    };

export type ErrorNotificationEvidence = {
  threadId: string;
  turnId: string;
  message: string | undefined;
  willRetry: boolean;
  info: DecodedCodexErrorInfo;
};

function isU16(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value >= 0 && value <= 65_535;
}

function decodeHttpError(tag: string, payload: unknown): DecodedCodexErrorInfo {
  if (!isRecord(payload) || !Object.hasOwn(payload, 'httpStatusCode')) {
    return { kind: 'invalid', raw: { [tag]: payload } };
  }
  const status = payload.httpStatusCode;
  if (status !== null && !isU16(status)) {
    return { kind: 'invalid', raw: { [tag]: payload } };
  }
  return {
    kind: 'known',
    value: { [tag]: { httpStatusCode: status } } as CodexErrorInfo,
  };
}

export function decodeCodexErrorInfo(value: unknown): DecodedCodexErrorInfo {
  if (value === null || value === undefined) {
    return { kind: 'none' };
  }
  if (typeof value === 'string') {
    if (STRING_CODEX_ERRORS.has(value as CodexErrorInfo)) {
      return { kind: 'known', value: value as CodexErrorInfo };
    }
    return value.length > 0 ? { kind: 'unknown', raw: value } : { kind: 'invalid', raw: value };
  }
  if (!isRecord(value)) {
    return { kind: 'invalid', raw: value };
  }

  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return { kind: 'invalid', raw: value };
  }
  const tag = keys[0];
  if (!tag) {
    return { kind: 'invalid', raw: value };
  }
  const payload = value[tag];
  if (HTTP_ERROR_TAGS.has(tag)) {
    return decodeHttpError(tag, payload);
  }
  if (tag === 'activeTurnNotSteerable') {
    if (!isRecord(payload) || (payload.turnKind !== 'review' && payload.turnKind !== 'compact')) {
      return { kind: 'invalid', raw: value };
    }
    return {
      kind: 'known',
      value: { activeTurnNotSteerable: { turnKind: payload.turnKind } },
    };
  }
  return { kind: 'unknown', raw: value };
}

export function decodeTurnError(turn: unknown): DecodedTurnError {
  if (!isRecord(turn) || !Object.hasOwn(turn, 'error') || turn.error === null || turn.error === undefined) {
    return { kind: 'absent' };
  }
  const raw = turn.error;
  if (!isRecord(raw)) {
    return { kind: 'invalid', message: undefined, info: { kind: 'invalid', raw }, raw };
  }
  const message = readString(raw.message);
  const info = decodeCodexErrorInfo(raw.codexErrorInfo);
  if (info.kind === 'known') {
    return { kind: 'known', message, info, raw };
  }
  if (info.kind === 'unknown' || info.kind === 'none') {
    return { kind: 'unknown', message, info, raw };
  }
  return { kind: 'invalid', message, info, raw };
}

export function readErrorNotificationEvidence(message: AppServerNotificationMessage): ErrorNotificationEvidence | null {
  if (message.method !== 'error') {
    return null;
  }
  const params = message.params;
  const threadId = readString(params?.threadId);
  const turnId = readString(params?.turnId);
  const willRetry = params?.willRetry;
  const error = params?.error;
  if (threadId === undefined || turnId === undefined || typeof willRetry !== 'boolean' || !isRecord(error)) {
    return null;
  }
  const info = decodeCodexErrorInfo(error.codexErrorInfo);
  return {
    threadId,
    turnId,
    message: readString(error.message),
    willRetry,
    info,
  };
}

function isServerOverloaded(info: DecodedCodexErrorInfo): boolean {
  return info.kind === 'known' && info.value === 'serverOverloaded';
}

export function isRecoverableServerOverload(
  turn: Turn,
  terminalEvidence: readonly ErrorNotificationEvidence[],
): boolean {
  if (turn.status !== 'failed') {
    return false;
  }
  const completedError = decodeTurnError(turn);
  if (completedError.kind === 'known') {
    return isServerOverloaded(completedError.info);
  }
  if (completedError.kind !== 'absent') {
    return false;
  }
  const lastTerminalError = terminalEvidence.at(-1);
  return lastTerminalError !== undefined && !lastTerminalError.willRetry && isServerOverloaded(lastTerminalError.info);
}

export function turnFailureMessage(
  turn: Turn,
  terminalEvidence: readonly ErrorNotificationEvidence[],
): string | undefined {
  const completedError = decodeTurnError(turn);
  if (completedError.kind !== 'absent' && completedError.message) {
    return completedError.message;
  }
  return terminalEvidence.at(-1)?.message;
}
