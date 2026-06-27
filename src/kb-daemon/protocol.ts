export const KB_DAEMON_READY_MESSAGE = 'coral.kb_daemon.ready';
export const KB_DAEMON_REQUEST_MESSAGE = 'coral.kb_daemon.request';
export const KB_DAEMON_RESPONSE_MESSAGE = 'coral.kb_daemon.response';
export const KB_DAEMON_EVENT_MESSAGE = 'coral.kb_daemon.event';
export const KB_DAEMON_PARENT_REQUEST_MESSAGE = 'coral.kb_daemon.parent_request';
export const KB_DAEMON_PARENT_RESPONSE_MESSAGE = 'coral.kb_daemon.parent_response';

export type KbDaemonRequestMethod =
  | 'health'
  | 'shutdown'
  | 'kb.read'
  | 'kb.mutate'
  | 'kb.abort'
  | 'kb.jobs'
  | 'kb.warmup'
  | 'expansion.rpc';

export type KbDaemonParentRequestMethod = 'curate.assistant.complete' | 'curate.assistant.cancel';

export const KB_DAEMON_CURATE_ASSISTANT_PURPOSES = [
  'classification',
  'principle-discovery',
  'community-summary',
  'git-conflict-resolution',
] as const;

export type KbDaemonCurateAssistantPurpose = (typeof KB_DAEMON_CURATE_ASSISTANT_PURPOSES)[number];

export const KB_DAEMON_CURATE_ASSISTANT_PERMISSION_MODES = ['default', 'auto', 'bypassPermissions'] as const;

export type KbDaemonCurateAssistantPermissionMode = (typeof KB_DAEMON_CURATE_ASSISTANT_PERMISSION_MODES)[number];

export const KB_DAEMON_KB_READ_METHODS = [
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

export type KbDaemonKbReadMethod = (typeof KB_DAEMON_KB_READ_METHODS)[number];

export const KB_DAEMON_KB_MUTATION_METHODS = [
  'setCommunitySummary',
  'createNote',
  'updateNote',
  'deleteNote',
  'createSource',
  'createWiki',
  'rewriteWiki',
  'linkWiki',
  'unlinkWiki',
  'citeWiki',
  'adoptWiki',
  'deleteWiki',
  'deleteSource',
  'createMemo',
  'deleteMemos',
  'reindex',
] as const;

export type KbDaemonKbMutationMethod = (typeof KB_DAEMON_KB_MUTATION_METHODS)[number];

export const KB_DAEMON_EXPANSION_METHODS = [
  'equipExpansion',
  'unequipExpansion',
  'removeExpansionCatalog',
  'listExpansion',
  'readBinding',
] as const;

export type KbDaemonExpansionMethod = (typeof KB_DAEMON_EXPANSION_METHODS)[number];

export type KbDaemonKbReadRequest = {
  method: KbDaemonKbReadMethod;
  args?: unknown;
  slug?: string;
  ctx?: unknown;
};

export type KbDaemonKbMutationRequest = {
  method: KbDaemonKbMutationMethod;
  args?: unknown;
  slug?: string;
  ctx?: unknown;
};

export type KbDaemonExpansionRequest = {
  method: KbDaemonExpansionMethod;
  args?: unknown;
};

export type KbDaemonCurateAssistantCompleteRequest = {
  prompt: string;
  purpose: KbDaemonCurateAssistantPurpose;
  model?: string;
  permissionMode?: KbDaemonCurateAssistantPermissionMode;
};

export type KbDaemonCurateAssistantCancelRequest = {
  requestId: string;
  reason?: string;
};

export type KbDaemonAbortRequest = {
  jobIds: string[];
};

export type KbDaemonAbortResult = {
  aborted: string[];
  notFound: string[];
};

export type KbDaemonJobsResult = {
  active: string[];
};

export type KbDaemonKbReadResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string; remediation?: string; detail?: unknown };

export type KbDaemonKbMutationResult = KbDaemonKbReadResult;

export type KbDaemonExpansionResult = KbDaemonKbReadResult;

export type KbDaemonRuntimeHealthPhase = 'not_initialized' | 'ready' | 'failed' | 'disposing' | 'disposed';

export type KbDaemonKbReadHealth = {
  phase: KbDaemonRuntimeHealthPhase;
  initializedAt?: number;
  lastError?: string;
  curateRunning?: boolean;
  mutationBlocked?: { owner: string; ageMs: number; signaledAtMs: number };
};

export type KbDaemonReadyMessage = {
  type: typeof KB_DAEMON_READY_MESSAGE;
  pid: number;
  startedAt: number;
  readyAt: number;
};

export type KbDaemonRequestMessage = {
  type: typeof KB_DAEMON_REQUEST_MESSAGE;
  id: string;
  method: KbDaemonRequestMethod;
  params?: unknown;
};

export type KbDaemonResponseMessage =
  | {
      type: typeof KB_DAEMON_RESPONSE_MESSAGE;
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: typeof KB_DAEMON_RESPONSE_MESSAGE;
      id: string;
      ok: false;
      error: { message: string };
    };

export type KbDaemonParentRequestMessage = {
  type: typeof KB_DAEMON_PARENT_REQUEST_MESSAGE;
  id: string;
  method: KbDaemonParentRequestMethod;
  params?: unknown;
};

export type KbDaemonParentResponseMessage =
  | {
      type: typeof KB_DAEMON_PARENT_RESPONSE_MESSAGE;
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: typeof KB_DAEMON_PARENT_RESPONSE_MESSAGE;
      id: string;
      ok: false;
      error: { message: string };
    };

export type KbDaemonEventMessage =
  | {
      type: typeof KB_DAEMON_EVENT_MESSAGE;
      event: 'journal';
      appended: unknown[];
    }
  | {
      type: typeof KB_DAEMON_EVENT_MESSAGE;
      event: 'corpus';
      publication: unknown;
    };

export type KbDaemonControlMessage =
  | KbDaemonReadyMessage
  | KbDaemonRequestMessage
  | KbDaemonResponseMessage
  | KbDaemonParentRequestMessage
  | KbDaemonParentResponseMessage
  | KbDaemonEventMessage;

export type KbDaemonHealthResult = {
  status: 'ready';
  pid: number;
  startedAt: number;
  uptimeMs: number;
  kbRead?: KbDaemonKbReadHealth;
  kbWrite?: KbDaemonKbReadHealth;
};

export function encodeKbDaemonMessage(message: KbDaemonControlMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isKbDaemonReadyMessage(value: unknown): value is KbDaemonReadyMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === KB_DAEMON_READY_MESSAGE &&
    isPositiveInteger(record.pid) &&
    isNonNegativeFiniteNumber(record.startedAt) &&
    isNonNegativeFiniteNumber(record.readyAt)
  );
}

export function isKbDaemonRequestMessage(value: unknown): value is KbDaemonRequestMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === KB_DAEMON_REQUEST_MESSAGE &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    (record.method === 'health' ||
      record.method === 'shutdown' ||
      record.method === 'kb.read' ||
      record.method === 'kb.mutate' ||
      record.method === 'kb.abort' ||
      record.method === 'kb.jobs' ||
      record.method === 'kb.warmup' ||
      record.method === 'expansion.rpc')
  );
}

export function isKbDaemonEventMessage(value: unknown): value is KbDaemonEventMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== KB_DAEMON_EVENT_MESSAGE) {
    return false;
  }
  if (record.event === 'journal') {
    return Array.isArray(record.appended);
  }
  return record.event === 'corpus' && record.publication !== undefined;
}

export function isKbDaemonResponseMessage(value: unknown): value is KbDaemonResponseMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== KB_DAEMON_RESPONSE_MESSAGE || typeof record.id !== 'string' || record.id.length === 0) {
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

export function isKbDaemonParentRequestMessage(value: unknown): value is KbDaemonParentRequestMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === KB_DAEMON_PARENT_REQUEST_MESSAGE &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    (record.method === 'curate.assistant.complete' || record.method === 'curate.assistant.cancel')
  );
}

export function isKbDaemonParentResponseMessage(value: unknown): value is KbDaemonParentResponseMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== KB_DAEMON_PARENT_RESPONSE_MESSAGE || typeof record.id !== 'string' || record.id.length === 0) {
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

export function isKbDaemonHealthResult(value: unknown): value is KbDaemonHealthResult {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.status === 'ready' &&
    isPositiveInteger(record.pid) &&
    isNonNegativeFiniteNumber(record.startedAt) &&
    isNonNegativeFiniteNumber(record.uptimeMs) &&
    (record.kbRead === undefined || isKbDaemonKbReadHealth(record.kbRead)) &&
    (record.kbWrite === undefined || isKbDaemonKbReadHealth(record.kbWrite))
  );
}

export function isKbDaemonKbReadHealth(value: unknown): value is KbDaemonKbReadHealth {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.phase === 'not_initialized' ||
      record.phase === 'ready' ||
      record.phase === 'failed' ||
      record.phase === 'disposing' ||
      record.phase === 'disposed') &&
    (record.initializedAt === undefined || isNonNegativeFiniteNumber(record.initializedAt)) &&
    (record.lastError === undefined || typeof record.lastError === 'string') &&
    (record.curateRunning === undefined || typeof record.curateRunning === 'boolean') &&
    (record.mutationBlocked === undefined || isKbDaemonMutationBlocked(record.mutationBlocked))
  );
}

function isKbDaemonMutationBlocked(value: unknown): value is NonNullable<KbDaemonKbReadHealth['mutationBlocked']> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.owner === 'string' &&
    isNonNegativeFiniteNumber(record.ageMs) &&
    isNonNegativeFiniteNumber(record.signaledAtMs)
  );
}

export function isKbDaemonKbReadMethod(value: unknown): value is KbDaemonKbReadMethod {
  return typeof value === 'string' && KB_DAEMON_KB_READ_METHODS.includes(value as KbDaemonKbReadMethod);
}

export function isKbDaemonKbMutationMethod(value: unknown): value is KbDaemonKbMutationMethod {
  return typeof value === 'string' && KB_DAEMON_KB_MUTATION_METHODS.includes(value as KbDaemonKbMutationMethod);
}

export function isKbDaemonExpansionMethod(value: unknown): value is KbDaemonExpansionMethod {
  return typeof value === 'string' && KB_DAEMON_EXPANSION_METHODS.includes(value as KbDaemonExpansionMethod);
}

export function isKbDaemonCurateAssistantPurpose(value: unknown): value is KbDaemonCurateAssistantPurpose {
  return (
    typeof value === 'string' && KB_DAEMON_CURATE_ASSISTANT_PURPOSES.includes(value as KbDaemonCurateAssistantPurpose)
  );
}

export function isKbDaemonCurateAssistantPermissionMode(
  value: unknown,
): value is KbDaemonCurateAssistantPermissionMode {
  return (
    typeof value === 'string' &&
    KB_DAEMON_CURATE_ASSISTANT_PERMISSION_MODES.includes(value as KbDaemonCurateAssistantPermissionMode)
  );
}

export function isKbDaemonKbReadRequest(value: unknown): value is KbDaemonKbReadRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isKbDaemonKbReadMethod(record.method) && (record.slug === undefined || typeof record.slug === 'string');
}

export function isKbDaemonKbMutationRequest(value: unknown): value is KbDaemonKbMutationRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isKbDaemonKbMutationMethod(record.method) && (record.slug === undefined || typeof record.slug === 'string');
}

export function isKbDaemonExpansionRequest(value: unknown): value is KbDaemonExpansionRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isKbDaemonExpansionMethod(record.method);
}

export function isKbDaemonCurateAssistantCompleteRequest(
  value: unknown,
): value is KbDaemonCurateAssistantCompleteRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.prompt === 'string' &&
    record.prompt.length > 0 &&
    isKbDaemonCurateAssistantPurpose(record.purpose) &&
    (record.model === undefined || typeof record.model === 'string') &&
    (record.permissionMode === undefined || isKbDaemonCurateAssistantPermissionMode(record.permissionMode))
  );
}

export function isKbDaemonCurateAssistantCancelRequest(value: unknown): value is KbDaemonCurateAssistantCancelRequest {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.requestId === 'string' &&
    record.requestId.length > 0 &&
    (record.reason === undefined || typeof record.reason === 'string')
  );
}

function isKbDaemonKbResult(value: unknown): value is KbDaemonKbReadResult {
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

export function isKbDaemonKbReadResult(value: unknown): value is KbDaemonKbReadResult {
  return isKbDaemonKbResult(value);
}

export function isKbDaemonKbMutationResult(value: unknown): value is KbDaemonKbMutationResult {
  return isKbDaemonKbResult(value);
}

export function isKbDaemonExpansionResult(value: unknown): value is KbDaemonExpansionResult {
  return isKbDaemonKbResult(value);
}

export function isKbDaemonAbortResult(value: unknown): value is KbDaemonAbortResult {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.aborted) &&
    record.aborted.every((entry) => typeof entry === 'string') &&
    Array.isArray(record.notFound) &&
    record.notFound.every((entry) => typeof entry === 'string')
  );
}

export function isKbDaemonJobsResult(value: unknown): value is KbDaemonJobsResult {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.active) && record.active.every((entry) => typeof entry === 'string');
}
