export const KB_CHILD_READY_MESSAGE = 'coral.kb_child.ready';
export const KB_CHILD_REQUEST_MESSAGE = 'coral.kb_child.request';
export const KB_CHILD_RESPONSE_MESSAGE = 'coral.kb_child.response';

export type KbChildRequestMethod = 'health' | 'shutdown';

export type KbChildReadyMessage = {
  type: typeof KB_CHILD_READY_MESSAGE;
  pid: number;
  startedAt: number;
  readyAt: number;
};

export type KbChildRequestMessage = {
  type: typeof KB_CHILD_REQUEST_MESSAGE;
  id: string;
  method: KbChildRequestMethod;
  params?: unknown;
};

export type KbChildResponseMessage =
  | {
      type: typeof KB_CHILD_RESPONSE_MESSAGE;
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: typeof KB_CHILD_RESPONSE_MESSAGE;
      id: string;
      ok: false;
      error: { message: string };
    };

export type KbChildControlMessage = KbChildReadyMessage | KbChildRequestMessage | KbChildResponseMessage;

export type KbChildHealthResult = {
  status: 'ready';
  pid: number;
  startedAt: number;
  uptimeMs: number;
};

export function encodeKbChildMessage(message: KbChildControlMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isKbChildReadyMessage(value: unknown): value is KbChildReadyMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === KB_CHILD_READY_MESSAGE &&
    isPositiveInteger(record.pid) &&
    isNonNegativeFiniteNumber(record.startedAt) &&
    isNonNegativeFiniteNumber(record.readyAt)
  );
}

export function isKbChildRequestMessage(value: unknown): value is KbChildRequestMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === KB_CHILD_REQUEST_MESSAGE &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    (record.method === 'health' || record.method === 'shutdown')
  );
}

export function isKbChildResponseMessage(value: unknown): value is KbChildResponseMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== KB_CHILD_RESPONSE_MESSAGE || typeof record.id !== 'string' || record.id.length === 0) {
    return false;
  }
  if (record.ok === true) {
    return true;
  }
  if (record.ok !== false || record.error === null || typeof record.error !== 'object') {
    return false;
  }
  return typeof (record.error as { message?: unknown }).message === 'string';
}

export function isKbChildHealthResult(value: unknown): value is KbChildHealthResult {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.status === 'ready' &&
    isPositiveInteger(record.pid) &&
    isNonNegativeFiniteNumber(record.startedAt) &&
    isNonNegativeFiniteNumber(record.uptimeMs)
  );
}
