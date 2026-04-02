import { isRecord, readString } from '../../shared/mcp-utils.js';
import type { ClaudeBootstrapSignature } from '../claude-appserver/protocol.js';

export { readString };

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
    permissionMode: value.permissionMode,
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
