import type { KbRuntime } from '../contract.js';
import {
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  normalizeCurateStateRepairFrontier,
  readCurateState,
  resolveCurateTimings,
  writeCurateState,
  type CurateCursor,
  type CurateState,
} from './state/index.js';
import {
  CURATE_ASSISTANT_MODEL,
  CURATE_ASSISTANT_PERMISSION_MODE,
  type CurateAssistantPort,
  type CurateAssistantPurpose,
} from './assistant.js';
import { curateDb } from './db-access.js';

export const CURATE_STALE_REASON = 'KB text snapshot is stale after kb_curate.';

export class CurateJsonParseError extends Error {
  constructor(phase: 'classification' | 'discovery') {
    super(`Curate ${phase} returned invalid JSON.`);
    this.name = 'CurateJsonParseError';
  }
}

export function persistCurateState(kb: KbRuntime, state: CurateState, next: CurateState | null): CurateState {
  if (next === null) {
    return state;
  }

  const normalizedNext = normalizeCurateStateRepairFrontier(curateDb(kb), next);
  writeCurateState(curateDb(kb), normalizedNext);
  return normalizedNext;
}

export function recordCurateFailureLocked(
  kb: KbRuntime,
  state: CurateState,
  through: CurateCursor | null,
  error: unknown,
): CurateState {
  return persistCurateState(
    kb,
    state,
    applyRecordCurateFailure(state, through, error, kb.time.now(), resolveCurateTimings(kb.envPort)),
  );
}

export async function recordCurateFailure(kb: KbRuntime, through: CurateCursor | null, error: unknown): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(curateDb(kb));
    recordCurateFailureLocked(kb, state, through, error);
  });
}

export function clearCurateRetryStateLocked(kb: KbRuntime, state: CurateState): CurateState {
  return persistCurateState(kb, state, applyClearCurateRetryState(state));
}

export async function clearCurateRetryState(kb: KbRuntime): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(curateDb(kb));
    clearCurateRetryStateLocked(kb, state);
  });
}

export async function runCurateAssistant(
  curateAssistant: CurateAssistantPort,
  prompt: string,
  purpose: CurateAssistantPurpose,
  signal?: AbortSignal,
): Promise<string> {
  return curateAssistant.complete({
    prompt,
    purpose,
    model: CURATE_ASSISTANT_MODEL,
    permissionMode: CURATE_ASSISTANT_PERMISSION_MODE,
    signal,
  });
}
