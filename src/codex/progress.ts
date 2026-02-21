/**
 * Progress file utilities for Codex execution visibility.
 * Pure helpers - no server dependencies.
 */

import { appendFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CodexThreadEvent } from '../types.js';

/** Create a progress file with metadata header. Returns the file path. */
export function createProgressFile(session: string, tool: string): string {
  const id = randomUUID();
  const filePath = join(tmpdir(), `coral-progress-${id}.jsonl`);
  try {
    writeFileSync(filePath, JSON.stringify({ progressId: id, session, tool, startedAt: Date.now() }) + '\n');
  } catch { /* non-fatal */ }
  return filePath;
}

/** Remove a progress file. Swallows errors (file may not exist). */
export function removeProgressFile(filePath: string): void {
  try { unlinkSync(filePath); } catch {}
}

/** Extract a human-readable progress message from a Codex JSONL event. */
export function extractProgressMessage(event: CodexThreadEvent): string | null {
  if (event.type === 'turn.started') return 'Processing...';
  if (event.type !== 'item.completed') return null;

  // Record cast avoids union narrowing issues with the catch-all CodexThreadItemDetails variant
  const item = event.item as Record<string, unknown>;
  switch (item.type) {
    case 'reasoning':
      return typeof item.text === 'string' ? item.text.slice(0, 120) : null;
    case 'web_search':
      return `Searching: ${item.query}`;
    case 'agent_message':
      return 'Generating response...';
    case 'command_execution':
      return `Running: ${item.command}`;
    case 'file_change': {
      const changes = item.changes as Array<{ path: string }> | undefined;
      return `Editing: ${changes?.[0]?.path ?? 'file'}`;
    }
    case 'mcp_tool_call':
      return `Calling: ${item.tool}`;
    default:
      return null;
  }
}

/** Extract the progress UUID from a progress file path. */
export function extractProgressId(filePath: string): string | null {
  const match = filePath.match(/coral-progress-([0-9a-f-]{36})\.jsonl$/);
  return match ? match[1] : null;
}

/** Append a progress event to the file. */
export function appendProgressEvent(filePath: string, eventType: string, message: string): void {
  try { appendFileSync(filePath, JSON.stringify({ ts: Date.now(), event: eventType, message }) + '\n'); }
  catch { /* file write must not break execution */ }
}

/** Append a terminal result event (completed or error) to the progress file. */
export function appendFinalResult(filePath: string, event: 'completed' | 'error', data: Record<string, unknown>): void {
  try { appendFileSync(filePath, JSON.stringify({ ts: Date.now(), event, ...data }) + '\n'); }
  catch { /* must not break execution */ }
}
