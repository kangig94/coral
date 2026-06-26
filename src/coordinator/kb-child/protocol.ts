export const KB_CHILD_READY_MESSAGE = 'coral.kb_child.ready';
export const KB_CHILD_REQUEST_MESSAGE = 'coral.kb_child.request';
export const KB_CHILD_RESPONSE_MESSAGE = 'coral.kb_child.response';

export type KbChildRequestMethod = 'health' | 'shutdown' | 'kb.read' | 'kb.mutate' | 'kb.warmup';

export const KB_CHILD_KB_READ_METHODS = [
  'readSearch',
  'diagnose',
  'readNote',
  'readSource',
  'readCommunity',
  'listStaleCommunities',
  'readCommunitySummaryInput',
  'readWiki',
  'readMemo',
  'readPrinciple',
  'listSources',
  'listWikis',
  'listMemos',
  'listPrinciples',
  'wakeUp',
] as const;

export type KbChildKbReadMethod = (typeof KB_CHILD_KB_READ_METHODS)[number];

export const KB_CHILD_KB_MUTATION_METHODS = ['createMemo', 'deleteMemos'] as const;

export type KbChildKbMutationMethod = (typeof KB_CHILD_KB_MUTATION_METHODS)[number];

export type KbChildKbReadRequest = {
  method: KbChildKbReadMethod;
  args?: unknown;
  slug?: string;
  ctx?: unknown;
};

export type KbChildKbMutationRequest = {
  method: KbChildKbMutationMethod;
  args?: unknown;
  slug?: string;
  ctx?: unknown;
};

export type KbChildKbReadResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; remediation?: string; detail?: unknown };

export type KbChildKbMutationResult = KbChildKbReadResult;

export type KbChildKbReadHealth = {
  phase: 'not_initialized' | 'ready' | 'failed';
  initializedAt?: number;
  lastError?: string;
};

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
  kbRead?: KbChildKbReadHealth;
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
    (record.method === 'health' ||
      record.method === 'shutdown' ||
      record.method === 'kb.read' ||
      record.method === 'kb.mutate' ||
      record.method === 'kb.warmup')
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
    isNonNegativeFiniteNumber(record.uptimeMs) &&
    (record.kbRead === undefined || isKbChildKbReadHealth(record.kbRead))
  );
}

export function isKbChildKbReadHealth(value: unknown): value is KbChildKbReadHealth {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.phase === 'not_initialized' || record.phase === 'ready' || record.phase === 'failed') &&
    (record.initializedAt === undefined || isNonNegativeFiniteNumber(record.initializedAt)) &&
    (record.lastError === undefined || typeof record.lastError === 'string')
  );
}

export function isKbChildKbReadMethod(value: unknown): value is KbChildKbReadMethod {
  return typeof value === 'string' && KB_CHILD_KB_READ_METHODS.includes(value as KbChildKbReadMethod);
}

export function isKbChildKbMutationMethod(value: unknown): value is KbChildKbMutationMethod {
  return typeof value === 'string' && KB_CHILD_KB_MUTATION_METHODS.includes(value as KbChildKbMutationMethod);
}

export function isKbChildKbReadRequest(value: unknown): value is KbChildKbReadRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isKbChildKbReadMethod(record.method) && (record.slug === undefined || typeof record.slug === 'string');
}

export function isKbChildKbMutationRequest(value: unknown): value is KbChildKbMutationRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isKbChildKbMutationMethod(record.method) && (record.slug === undefined || typeof record.slug === 'string');
}

function isKbChildKbResult(value: unknown): value is KbChildKbReadResult {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true) {
    return 'data' in record;
  }
  if (record.ok !== false || typeof record.code !== 'string' || typeof record.message !== 'string') {
    return false;
  }
  return record.remediation === undefined || typeof record.remediation === 'string';
}

export function isKbChildKbReadResult(value: unknown): value is KbChildKbReadResult {
  return isKbChildKbResult(value);
}

export function isKbChildKbMutationResult(value: unknown): value is KbChildKbMutationResult {
  return isKbChildKbResult(value);
}
