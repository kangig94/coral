/**
 * Shared provider session operations.
 * Eliminates duplication between codex and claude server-handlers.
 */

import { activeSessions } from '../runner/job-manager.js';
import type { SessionManager } from '../runner/session-manager.js';
import type { SessionProvider } from '../runner/types.js';
import { type McpResult, textResult, jsonResult } from '../shared/mcp-utils.js';

export function sessionNotFoundError(ref: string, provider: string): McpResult {
  return textResult(
    `Session not found: "${ref}". To resume, use a coral session UUID. Use ${provider}({ op: "list" }) to see registered sessions, or ${provider}({ op: "exec" }) to start a new session.`,
    true,
  );
}

export function handleSessionList(mgr: SessionManager, provider: SessionProvider): McpResult {
  const registered = mgr.list(provider).map((s) => {
    const active = activeSessions.get(s.id);
    const isRunning = active?.provider === provider && active?.terminalState === 'running';
    return {
      name: s.name,
      session: s.id,
      model: s.model,
      created_at: s.createdAt,
      last_used_at: s.lastUsedAt,
      working_directory: s.workingDirectory,
      status: isRunning ? 'running' : 'completed',
    };
  });

  return jsonResult({ sessions: registered, total: registered.length });
}

export function handleSessionAbort(session: string, provider: SessionProvider): McpResult {
  const entry = activeSessions.get(session);
  if (!entry || entry.provider !== provider) {
    return textResult(
      `No active execution found for session "${session}". The session may have already completed or the ID is invalid.`,
      true,
    );
  }

  entry.controller.abort();
  return jsonResult({ session, session_name: entry.sessionName, status: 'abort_requested' });
}
