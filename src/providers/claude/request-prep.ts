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
const DEFAULT_CLAUDE_MODEL_CAP = 'opus';
const CLAUDE_MODEL_TIERS: Readonly<Record<string, number>> = Object.freeze({ ...ABSTRACT_MODEL_TIERS, fable: 4 });
const OPUS_RANK = ABSTRACT_MODEL_TIERS.opus;

function resolveClaudeModelCap(env: Record<string, string>): string {
  const configured = env.CORAL_CLAUDE_MODEL_CAP;
  return configured !== undefined && CLAUDE_MODEL_TIERS[configured] !== undefined
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
 * Resolve the model for a Coral-launched Claude session, capped by
 * `CORAL_CLAUDE_MODEL_CAP` (default `opus`).
 *
 * Precedence: an explicit per-request `model` wins outright; else
 * `CORAL_CLAUDE_MODEL` is the launch default; else `undefined`, which leaves the
 * model unspecified so Claude uses its own default (Coral states no
 * opinion). Empty string is treated as unset.
 *
 * The control flow deliberately differs from the Codex analog
 * (`resolveModelTier(model) ?? env ?? DEFAULT`, a single fall-through): the
 * request branch returns *without* consulting the env, so a soft per-request
 * tier never silently adopts the operator default. The env default, in
 * contrast, is applied verbatim even for an in-cap abstract tier — there
 * `resolveModelTier` returns `undefined` to defer to the provider, but an
 * explicit operator config must take effect, so we fall back to the configured
 * value.
 */
export function resolveClaudeModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const cap = resolveClaudeModelCap(env);
  if (model !== undefined) {
    return resolveModelTier(model, cap, CLAUDE_MODEL_TIERS);
  }
  const envModel = env.CORAL_CLAUDE_MODEL;
  if (envModel === undefined || envModel.length === 0) {
    return undefined;
  }
  const cappedDefault = resolveModelTier(envModel, cap, CLAUDE_MODEL_TIERS);
  return cappedDefault ?? envModel;
}

function resolveClaudeEffort(request: Pick<ProviderRequest, 'effort' | 'model' | 'coralEnv'>): EffortLevel {
  const resolved = resolveProviderEffort(request, 'CORAL_CLAUDE_EFFORT', request.coralEnv) ?? CLAUDE_DEFAULT_EFFORT;
  // Claude has no `ultra` (Codex GPT-5.6 Sol/Terra only) — collapse to Claude ceiling.
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
  const capRank = CLAUDE_MODEL_TIERS[resolveClaudeModelCap(env)] ?? OPUS_RANK;
  const configuredModel = model ?? (env.CORAL_CLAUDE_MODEL || undefined);
  if (configuredModel === undefined) {
    return capRank >= OPUS_RANK;
  }

  const abstractRank = CLAUDE_MODEL_TIERS[configuredModel];
  if (abstractRank !== undefined) {
    return Math.min(abstractRank, capRank) >= OPUS_RANK;
  }

  if (/sonnet|haiku/i.test(configuredModel)) {
    return false;
  }

  return true;
}
