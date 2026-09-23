import { createHash } from 'node:crypto';

import type { ProviderRequest, EffortLevel } from '../contract.js';
import { CORAL_CHILD_PRINCIPAL_HANDLE } from '../../security/child-principal-env.js';
import { ABSTRACT_MODEL_TIERS, resolveModelTier, resolveProviderEffort } from '../request-policy.js';
import { isRecord, readString } from '../../infra/json.js';
import { z } from 'zod';

const OUTPUT_STYLE_OVERRIDE =
  'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.';

export type PreparedClaudeRequest = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  effort: EffortLevel;
};

export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

export const claudeBootstrapSignatureSchema = z
  .object({
    cwd: z.string(),
    systemPromptHash: z.string(),
    permissionMode: permissionModeSchema,
    bootstrapConfigHash: z.string(),
  })
  .strict();
export type ClaudeBootstrapSignature = z.infer<typeof claudeBootstrapSignatureSchema>;

export type ClaudeBootstrapConfiguration = Readonly<{
  conversationRef?: string;
  resumeExisting?: boolean;
  projectsRoot: string;
  model?: string;
  effort?: EffortLevel;
}>;

const CLAUDE_DEFAULT_EFFORT: EffortLevel = 'xhigh';
const DEFAULT_CLAUDE_MODEL_CAP = 'fable';
const OPUS_RANK = ABSTRACT_MODEL_TIERS.opus;

function resolveClaudeModelCap(env: Record<string, string>): string {
  const configured = env.CORAL_CLAUDE_MODEL_CAP;
  return configured !== undefined && ABSTRACT_MODEL_TIERS[configured] !== undefined
    ? configured
    : DEFAULT_CLAUDE_MODEL_CAP;
}

export function hashSortedEnv(env: Record<string, string>): string {
  const sortedEntries: [string, string][] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'CORAL_CHILD' && key !== CORAL_CHILD_PRINCIPAL_HANDLE) {
      sortedEntries.push([key, value]);
    }
  }
  sortedEntries.sort(([left], [right]) => left.localeCompare(right));
  return `sha256:${createHash('sha256').update(JSON.stringify(sortedEntries)).digest('hex')}`;
}

export function readTurnConversationRef(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readString(value.conversationRef) ?? readString(value.sessionId);
}

export function readBootstrapSignature(value: unknown): ClaudeBootstrapSignature | undefined {
  const parsed = claudeBootstrapSignatureSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function sameBootstrapSignature(a: ClaudeBootstrapSignature, b: ClaudeBootstrapSignature): boolean {
  return (
    a.cwd === b.cwd &&
    a.systemPromptHash === b.systemPromptHash &&
    a.permissionMode === b.permissionMode &&
    a.bootstrapConfigHash === b.bootstrapConfigHash
  );
}

export function hashClaudeBootstrapConfiguration(configuration: ClaudeBootstrapConfiguration): string {
  const normalized = {
    conversationRef: configuration.conversationRef ?? null,
    resumeExisting: configuration.resumeExisting ?? false,
    projectsRoot: configuration.projectsRoot,
    model: configuration.model ?? null,
    effort: configuration.effort ?? null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export function normalizeControllerEnv(env?: Record<string, string>): Record<string, string> {
  if (!env) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolve the model for a Coral-launched Claude session.
 *
 * The request model (the agent's frontmatter `model`, overridden by `--model`) wins; else
 * `CORAL_CLAUDE_MODEL`; else `undefined`, which leaves the choice to Claude. An abstract tier is
 * sent as the tier alias itself, capped by `CORAL_CLAUDE_MODEL_CAP` (default `fable`). A present
 * request model must never fall back to the env default, even when capped.
 */
export function resolveClaudeModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const envModel = env.CORAL_CLAUDE_MODEL;
  const requested = model ?? (envModel === undefined || envModel.length === 0 ? undefined : envModel);
  return resolveModelTier(requested, resolveClaudeModelCap(env));
}

function resolveClaudeEffort(request: Pick<ProviderRequest, 'effort' | 'model' | 'coralEnv'>): EffortLevel {
  const resolved = resolveProviderEffort(request, 'CORAL_CLAUDE_EFFORT', request.coralEnv) ?? CLAUDE_DEFAULT_EFFORT;
  // Claude has no `ultra` — collapse to Claude's ceiling.
  const withoutUltra = resolved === 'ultra' ? 'max' : resolved;
  if (withoutUltra !== 'xhigh') {
    return withoutUltra;
  }

  return isAtLeastOpusEffectiveTier(request.model, request.coralEnv) ? 'xhigh' : 'max';
}

/**
 * The inject bundle is applied provider-agnostically by `applyInjectBundle` at the job shell
 * boundary and arrives pre-merged into `request.systemPrompt` (guidelines first,
 * caller systemPrompt appended). This function must not re-resolve the inject bundle.
 */
export function buildPreparedClaudeRequest(
  request: Pick<ProviderRequest, 'prompt' | 'instruction' | 'systemPrompt' | 'coralEnv' | 'model' | 'effort'>,
): PreparedClaudeRequest {
  const systemParts: string[] = [];
  let prompt = request.prompt;

  // systemPrompt first so the inject bundle leads the system channel.
  if (request.systemPrompt) {
    systemParts.push(request.systemPrompt);
  }

  if (request.instruction) {
    if (request.instruction.channel === 'system') {
      systemParts.push(request.instruction.content);
    } else {
      prompt = `${request.instruction.content}\n\n---\n\n${request.prompt}`;
    }
  }

  systemParts.push(OUTPUT_STYLE_OVERRIDE);

  return {
    prompt,
    systemPrompt: systemParts.join('\n\n'),
    model: resolveClaudeModel(request.model, request.coralEnv),
    effort: resolveClaudeEffort(request),
  };
}

function isAtLeastOpusEffectiveTier(model: string | undefined, env: Record<string, string>): boolean {
  const capRank = ABSTRACT_MODEL_TIERS[resolveClaudeModelCap(env)] ?? OPUS_RANK;
  const configuredModel = model ?? (env.CORAL_CLAUDE_MODEL || undefined);
  if (configuredModel === undefined) {
    return capRank >= OPUS_RANK;
  }

  const abstractRank = ABSTRACT_MODEL_TIERS[configuredModel];
  if (abstractRank !== undefined) {
    return Math.min(abstractRank, capRank) >= OPUS_RANK;
  }

  if (/sonnet|haiku/i.test(configuredModel)) {
    return false;
  }

  return true;
}
