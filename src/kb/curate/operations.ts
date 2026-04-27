import type { KbRuntime } from '../contract.js';
import { normalizeCurateStateRepairFrontier, readCurateState, writeCurateState } from './state/index.js';
import {
  applyClearCurateRetryState,
  applyRecordCurateFailure,
  type CurateCursor,
  type CurateState,
} from './state/index.js';
import type { SpawnCliFn } from './pipeline-types.js';

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

  const normalizedNext = normalizeCurateStateRepairFrontier(kb, next);
  writeCurateState(kb, normalizedNext);
  return normalizedNext;
}

export function recordCurateFailureLocked(
  kb: KbRuntime,
  state: CurateState,
  through: CurateCursor | null,
  error: unknown,
): CurateState {
  return persistCurateState(kb, state, applyRecordCurateFailure(state, through, error, kb.time.now()));
}

export async function recordCurateFailure(
  kb: KbRuntime,
  through: CurateCursor | null,
  error: unknown,
): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    recordCurateFailureLocked(kb, state, through, error);
  });
}

export function clearCurateRetryStateLocked(kb: KbRuntime, state: CurateState): CurateState {
  return persistCurateState(kb, state, applyClearCurateRetryState(state));
}

export async function clearCurateRetryState(kb: KbRuntime): Promise<void> {
  await kb.withMutationLock(() => {
    const state = readCurateState(kb);
    clearCurateRetryStateLocked(kb, state);
  });
}

export async function runCurateClaude(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  prompt: string,
  extraArgs?: string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await spawnCli({
    provider: 'claude',
    command: 'claude',
    args: ['-p', '--no-session-persistence', ...(extraArgs ?? [])],
    prompt,
    cwd: kb.markdownRoot,
    pool: 'curate',
    signal,
  });

  if (result.aborted) {
    throw new Error('Claude invocation aborted during curate.');
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      stderr ? `Claude exited with code ${result.code}: ${stderr}` : `Claude exited with code ${result.code}`,
    );
  }

  return result.stdout;
}
