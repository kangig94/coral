import { textResult, jsonResult, type McpResult } from '../../shared/mcp-utils.js';
import type { EndReason, DiscussState, Result } from '../types.js';
import type { SessionStore } from '../session-store.js';

export function resolveSession(store: SessionStore, sessionId: string): string | McpResult {
  const dir = store.resolveDir(sessionId);
  return dir ?? textResult('session_not_found', true);
}

export function nowIsoString(): string {
  return new Date().toISOString();
}

export function resultToMcp(result: Result<unknown>): McpResult {
  if (!result.ok) {
    return jsonResult({ error: result.error, ...result.detail });
  }
  return jsonResult(result.value as Record<string, unknown>);
}

export async function loadState(store: SessionStore, sessionDir: string): Promise<DiscussState> {
  return store.withLock(sessionDir, async () => store.load(sessionDir));
}

export function endContent(reason: Exclude<EndReason, 'already_ended'>): string {
  const reasons: Record<Exclude<EndReason, 'already_ended'>, string> = {
    all_below_threshold: 'All participants bid below the threshold. Ending discussion.',
    max_epochs_reached: 'Maximum epochs reached. Ending discussion.',
    all_blocked: 'Discussion is structurally deadlocked. Agents who want to speak have no quota, and agents with quota do not want to speak.',
    no_participants: 'No eligible agents remaining. Ending discussion.',
  };

  return reasons[reason];
}
