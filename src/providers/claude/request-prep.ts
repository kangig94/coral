import { createHash } from 'node:crypto';

import { resolveInjectMd } from '../inject.js';
import type { ProviderRequest } from '../contract.js';
import type { StoragePort } from '../../runtime/ports.js';
import { ABSTRACT_MODEL_TIERS, resolveModelTier, resolveProviderEffort, type EffortLevel } from '../request-policy.js';
import { isRecord, readString } from '../../infra/json.js';
import type { PermissionMode } from './control-protocol.js';
import type { ClaudeBootstrapSignature } from '../claude-appserver/protocol.js';

export { readString };

export const OUTPUT_STYLE_OVERRIDE =
  'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.';

export type PreparedClaudeRequest = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  effort: EffortLevel;
};

const CLAUDE_DEFAULT_EFFORT: EffortLevel = 'xhigh';
const OPUS_RANK = ABSTRACT_MODEL_TIERS.opus;

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

export function resolveClaudeModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const cap = env.CORAL_CLAUDE_MODEL_CAP ?? 'opus';
  return resolveModelTier(model, cap);
}

export function resolveClaudeEffort(
  request: Pick<ProviderRequest, 'effort' | 'model' | 'coralEnv'>,
): EffortLevel {
  const resolved = resolveProviderEffort(request, 'CORAL_CLAUDE_EFFORT', request.coralEnv) ?? CLAUDE_DEFAULT_EFFORT;
  if (resolved !== 'xhigh') {
    return resolved;
  }

  return isOpusEffectiveTier(request.model, request.coralEnv) ? 'xhigh' : 'max';
}

export function buildPreparedClaudeRequest(
  request: Pick<
    ProviderRequest,
    'prompt' | 'instruction' | 'systemPrompt' | 'cwd' | 'coralEnv' | 'model' | 'effort' | 'bypassPermissions'
  >,
  storage: Pick<StoragePort, 'readFileSync'>,
): PreparedClaudeRequest {
  const systemParts: string[] = [];
  let prompt = request.prompt;

  const injectMd = resolveInjectMd({
    storage,
    workingDirectory: request.cwd,
    ownerSessionId: request.coralEnv?.CORAL_OWNER,
    coralEnv: request.coralEnv,
  });
  if (injectMd) {
    systemParts.push(injectMd);
  }

  if (request.instruction) {
    if (request.instruction.channel === 'system') {
      systemParts.push(request.instruction.content);
    } else {
      prompt = `${request.instruction.content}\n\n---\n\n${request.prompt}`;
    }
  }

  if (request.systemPrompt) {
    systemParts.push(request.systemPrompt);
  }

  systemParts.push(OUTPUT_STYLE_OVERRIDE);

  return {
    prompt,
    systemPrompt: systemParts.join('\n\n'),
    model: resolveClaudeModel(request.model, request.coralEnv),
    effort: resolveClaudeEffort(request),
  };
}

function isOpusEffectiveTier(model: string | undefined, env: Record<string, string>): boolean {
  const capRank = ABSTRACT_MODEL_TIERS[env.CORAL_CLAUDE_MODEL_CAP ?? 'opus'] ?? OPUS_RANK;
  if (model === undefined) {
    return capRank === OPUS_RANK;
  }

  const abstractRank = ABSTRACT_MODEL_TIERS[model];
  if (abstractRank !== undefined) {
    return Math.min(abstractRank, capRank) === OPUS_RANK;
  }

  if (/sonnet|haiku/i.test(model)) {
    return false;
  }

  return true;
}
