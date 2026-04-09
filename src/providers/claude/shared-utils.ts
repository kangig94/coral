import { createHash } from 'node:crypto';

import { isRecord, readString } from '../../shared/utils.js';
import type { PermissionMode } from './control-protocol.js';
import type { ClaudeBootstrapSignature } from '../claude-appserver/protocol.js';

export { readString };

/** SHA-256 hash of sorted env entries (excluding CORAL_CHILD). Shared by adapter and broker. */
export function hashSortedEnv(env: Record<string, string>): string {
  const sortedEntries = Object.entries(env)
    .filter(([key]) => key !== 'CORAL_CHILD')
    .sort(([left], [right]) => left.localeCompare(right));
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex')}`;
}

export function readBootstrapSignature(value: unknown): ClaudeBootstrapSignature | undefined {
  if (
    !isRecord(value) ||
    typeof value.cwd !== 'string' ||
    typeof value.systemPromptHash !== 'string' ||
    typeof value.permissionMode !== 'string'
  ) {
    return undefined;
  }

  return {
    cwd: value.cwd,
    systemPromptHash: value.systemPromptHash,
    permissionMode: value.permissionMode as PermissionMode,
  };
}

export function sameBootstrapSignature(a: ClaudeBootstrapSignature, b: ClaudeBootstrapSignature): boolean {
  return a.cwd === b.cwd && a.systemPromptHash === b.systemPromptHash && a.permissionMode === b.permissionMode;
}

export function normalizeControllerEnv(env?: Record<string, string>): Record<string, string> {
  if (!env) {
    return {};
  }

  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'));
}
