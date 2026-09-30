import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { EffortLevel, ProviderContinuityUpdate, ProviderRequest, ProviderRuntime } from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { resolveProviderEffort } from '../request-policy.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { readString } from '../../infra/json.js';
import type { ProviderTransportClose } from '../protocol.js';
import type { ThreadResumeParams, ThreadStartParams, TurnStartParams, UserInput } from './protocol.js';
import type { RecoverableTurnFailure } from './turn-recovery.js';
import type { CodexExecutionPlan } from './execution-plan.js';
import { isCodexSizedModel, isCodexSize, type CodexModelCatalog, type CodexSize } from './model-catalog.js';
import { zodPersistedParser } from '../binding-parser.js';
import {
  canonicalizeWorkDir,
  canonicalWorkDirWireSchema,
  containsWorkDir,
  type CanonicalWorkDir,
} from '../../runtime/canonical-work-dir.js';

const codexPersistedContinuitySchema = z
  .object({
    cwd: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (continuity) =>
      continuity.cwd !== undefined || continuity.threadId !== undefined || continuity.turnId !== undefined,
    'Codex persisted continuity must contain at least one provider field.',
  )
  .describe('non-empty-codex-persisted-continuity');

export const codexPersistedContinuityParser = zodPersistedParser(() => codexPersistedContinuitySchema);

export interface CodexPersistedContinuity extends ProviderContinuityBlob {
  cwd?: string;
  threadId?: string;
  turnId?: string;
}

type CodexContinuityReadOptions = {
  cwdScope?: string;
};

/**
 * Assemble the single Codex turn text.
 *
 * Order is presentation-only (Codex has no separate system channel): guidelines /
 * systemPrompt first, then agent instruction, then the user task. The inject bundle is
 * pre-merged into `systemPrompt` by `applyInjectBundle` at the job shell boundary.
 */
export function buildCodexPrompt(
  request: Pick<ProviderRequest, 'action' | 'instruction' | 'systemPrompt' | 'prompt'>,
): string {
  const parts: string[] = [];
  if (request.systemPrompt) {
    parts.push(request.systemPrompt);
  }
  if (request.action !== 'resume' && request.instruction) {
    parts.push(request.instruction.content);
  }
  parts.push(request.prompt);
  return parts.join('\n\n---\n\n');
}

const CODEX_DEFAULT_EFFORT: EffortLevel = 'high';
/** Terra/Luna get a higher reasoning floor — smaller sizes compensate with more effort. */
const CODEX_TERRA_LUNA_MIN_EFFORT: EffortLevel = 'xhigh';
const CODEX_SIZED_EFFORT_CEILING: EffortLevel = 'ultra';
const CODEX_LUNA_EFFORT_CEILING: EffortLevel = 'max';
const CODEX_LEGACY_EFFORT_CEILING: EffortLevel = 'xhigh';
const EFFORT_RANK: Record<EffortLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
};
export type CodexServiceTier = 'default' | 'fast' | 'flex';
const serviceTierCache = new Map<string, { mtimeMs: number; value: CodexServiceTier | undefined }>();

function isCodexTerraOrLuna(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === 'terra' || normalized === 'luna' || normalized.endsWith('-terra') || normalized.endsWith('-luna')
  );
}

function isCodexLuna(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === 'luna' || normalized.endsWith('-luna');
}

function codexEffortCeiling(model: string): EffortLevel {
  if (!isCodexSizedModel(model)) {
    return CODEX_LEGACY_EFFORT_CEILING;
  }
  if (isCodexLuna(model)) {
    return CODEX_LUNA_EFFORT_CEILING;
  }
  return CODEX_SIZED_EFFORT_CEILING;
}

/** An effort string Coral cannot rank must never become a ceiling. */
function highestKnownEffort(efforts: readonly string[]): EffortLevel | undefined {
  let highest: EffortLevel | undefined;
  for (const effort of efforts) {
    if (!Object.hasOwn(EFFORT_RANK, effort)) continue;
    const level = effort as EffortLevel;
    if (highest === undefined || EFFORT_RANK[level] > EFFORT_RANK[highest]) highest = level;
  }
  return highest;
}

function clampEffort(level: EffortLevel, min: EffortLevel | undefined, max: EffortLevel): EffortLevel {
  let result = level;
  if (min !== undefined && EFFORT_RANK[result] < EFFORT_RANK[min]) {
    result = min;
  }
  if (EFFORT_RANK[result] > EFFORT_RANK[max]) {
    result = max;
  }
  return result;
}

function resolveCodexEffort(request: ProviderRequest, model: string, ceiling: EffortLevel): EffortLevel {
  const resolved = resolveProviderEffort(request, 'CORAL_CODEX_EFFORT', request.coralEnv) ?? CODEX_DEFAULT_EFFORT;
  const floor = isCodexTerraOrLuna(model) ? CODEX_TERRA_LUNA_MIN_EFFORT : undefined;
  return clampEffort(resolved, floor, ceiling);
}

function resolveCodexSandbox(bypassPermissions: boolean): 'workspace-write' | 'danger-full-access' {
  return bypassPermissions ? 'danger-full-access' : 'workspace-write';
}

export function readCodexPersistedContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  options: CodexContinuityReadOptions = {},
): CodexPersistedContinuity {
  if (persistedContinuity === undefined) return {};
  const decoded = codexPersistedContinuityParser.parse(persistedContinuity);
  if (!decoded.success) throw new TypeError('Invalid persisted Codex continuity.');
  const continuity = decoded.data;
  const cwdScope = readString(options.cwdScope);
  const cwd = readString(continuity.cwd);
  // Build the way `buildCodexContinuity` does — a key present with an `undefined` value is not the
  // same as an absent key once this reaches the durable JSON boundary, which has no `undefined` and
  // rejects it. Claude's reader returns Zod's parsed data directly and never had the hazard.
  const resolvedCwd =
    cwdScope === undefined ? (cwd === undefined ? undefined : resolve(cwd)) : scopedCodexCwd(cwd, cwdScope);
  const threadId = readString(continuity.threadId);
  const turnId = readString(continuity.turnId);
  return {
    ...(resolvedCwd === undefined ? {} : { cwd: resolvedCwd }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}

export function buildCodexContinuity(update: {
  cwd?: string;
  threadId?: string;
  turnId?: string;
}): CodexPersistedContinuity {
  const cwd = readString(update.cwd);
  const threadId = readString(update.threadId);
  const turnId = readString(update.turnId);
  const continuity = {
    ...(cwd !== undefined ? { cwd: resolve(cwd) } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
  return continuity;
}

export function withCodexContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  update: {
    cwd?: string;
    threadId?: string;
    turnId?: string;
  },
  options: CodexContinuityReadOptions = {},
): CodexPersistedContinuity {
  const continuity = readCodexPersistedContinuity(persistedContinuity, options);
  return buildCodexContinuity({
    cwd: update.cwd ?? continuity.cwd,
    threadId: update.threadId ?? continuity.threadId,
    turnId: update.turnId ?? continuity.turnId,
  });
}

export function clearCodexTurnContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  options: CodexContinuityReadOptions = {},
): CodexPersistedContinuity | undefined {
  const continuity = readCodexPersistedContinuity(persistedContinuity, options);
  if (!continuity.threadId) {
    return undefined;
  }

  return buildCodexContinuity({
    cwd: continuity.cwd,
    threadId: continuity.threadId,
  });
}

export function hasCodexContinuity(continuity: CodexPersistedContinuity): boolean {
  return continuity.cwd !== undefined || continuity.threadId !== undefined || continuity.turnId !== undefined;
}

export function snapshotCodexPersistedContinuity(persistedContinuity: CodexPersistedContinuity | undefined): {
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity: CodexPersistedContinuity | null;
} {
  const continuity = buildCodexContinuity({
    cwd: persistedContinuity?.cwd,
    threadId: persistedContinuity?.threadId,
    turnId: persistedContinuity?.turnId,
  });
  return {
    conversationRef: continuity.threadId ?? null,
    resumable: Boolean(continuity.threadId),
    providerContinuity: hasCodexContinuity(continuity) ? continuity : null,
  };
}

export function applyCodexContinuityUpdate(
  persistedContinuity: CodexPersistedContinuity,
  update: ProviderContinuityUpdate,
): CodexPersistedContinuity {
  if (update.providerContinuity !== undefined) {
    return readCodexPersistedContinuity(update.providerContinuity as ProviderContinuityBlob | undefined);
  }

  if (update.conversationRef === null || update.resumable === false) {
    return {};
  }

  const conversationRef = readString(update.conversationRef);
  if (conversationRef !== undefined) {
    return withCodexContinuity(persistedContinuity, { threadId: conversationRef });
  }

  return persistedContinuity;
}

export function applyCodexTransportClosed(
  persistedContinuity: CodexPersistedContinuity,
  _closed: ProviderTransportClose,
): CodexPersistedContinuity {
  return persistedContinuity;
}

export function isCodexSessionUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('missing thread') ||
    message.includes('unknown thread') ||
    message.includes('does not exist') ||
    message.includes('no such thread') ||
    message.includes('no longer resumable because the saved thread is missing or invalid')
  );
}

function scopedCodexCwd(cwd: string | undefined, cwdScope: string | undefined): string | undefined {
  if (cwd === undefined || cwdScope === undefined) {
    return undefined;
  }

  const resolvedScope = canonicalWorkDirWireSchema.parse(resolve(cwdScope));
  const resolvedCwd = canonicalWorkDirWireSchema.parse(resolve(cwd));
  return containsWorkDir(resolvedScope, resolvedCwd) ? resolvedCwd : undefined;
}

export function resolveCodexHostCwd(
  requestCwd: CanonicalWorkDir,
  persistedContinuity: ProviderContinuityBlob | undefined,
): CanonicalWorkDir {
  const persistedCwd = readCodexPersistedContinuity(persistedContinuity, { cwdScope: requestCwd }).cwd;
  return persistedCwd === undefined ? requestCwd : canonicalizeWorkDir(persistedCwd, requestCwd);
}

function buildCodexTurnInput(prompt: string): UserInput[] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

const DEFAULT_CODEX_MODEL = 'sol';

const CODEX_SIZE_MODEL: Readonly<Record<CodexSize, string>> = Object.freeze({
  astra: 'gpt-6-astra',
  sol: 'gpt-6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-6-luna',
});

type ResolvedCodexModel = Pick<CodexModelSelection, 'model' | 'source'>;

function resolveCodexModelId(model: string, catalog: CodexModelCatalog): ResolvedCodexModel {
  const size = model.trim().toLowerCase();
  if (!isCodexSize(size)) return { model, source: { kind: 'pinned' } };
  if (catalog.kind === 'unavailable') {
    return {
      model: CODEX_SIZE_MODEL[size],
      source: { kind: 'built-in', cause: 'catalog-unavailable', reason: catalog.reason },
    };
  }
  const listedModel = catalog.newestBySize[size];
  return listedModel === undefined
    ? { model: CODEX_SIZE_MODEL[size], source: { kind: 'built-in', cause: 'size-unlisted', size } }
    : { model: listedModel, source: { kind: 'catalog' } };
}

const CODEX_ABSTRACT_MODEL: Readonly<Record<string, CodexSize>> = Object.freeze({
  fable: 'astra',
  opus: 'sol',
  sonnet: 'terra',
  haiku: 'luna',
});

function normalizeServiceTierEnv(value: string | undefined): CodexServiceTier | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized === '1') return 'fast';
  if (normalized === '0') return 'default';
  return undefined;
}

/**
 * Profile-scoped values under `[profiles.xxx]` are intentionally ignored.
 */
function readCodexConfigServiceTier(
  runtime: Pick<ProviderRuntime<CodexExecutionPlan>, 'executionPlan' | 'storage'>,
): CodexServiceTier | undefined {
  if (!runtime.storage) {
    return undefined;
  }
  const configPath = join(runtime.executionPlan.host.access.home, 'config.toml');
  // Set only when statSync succeeds; stays undefined when stat throws a
  // non-ENOENT/EACCES error but readFileSync still works, so both cache-write
  // sites below fall back to `?? 0` (treated as always-stale).
  let cachedMtimeMs: number | undefined;

  try {
    cachedMtimeMs = runtime.storage.statSync(configPath).mtimeMs;
    const cached = serviceTierCache.get(configPath);
    if (cached && cached.mtimeMs === cachedMtimeMs) {
      return cached.value;
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'EACCES') {
      serviceTierCache.set(configPath, { mtimeMs: 0, value: undefined });
      return undefined;
    }
  }

  try {
    const content = runtime.storage.readFileSync(configPath, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      if (/^\s*\[/.test(line)) {
        break;
      }
      const match = line.match(/^\s*service_tier\s*=\s*["']?(default|fast|flex)["']?\s*(#.*)?$/i);
      if (match) {
        const value = match[1].toLowerCase() as CodexServiceTier;
        serviceTierCache.set(configPath, { mtimeMs: cachedMtimeMs ?? 0, value });
        return value;
      }
    }
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== 'EACCES') {
      const message = errorMessage(error);
      backendLog.warn(
        `Could not read service_tier from the selected Codex config.toml: ${message}. Set CORAL_CODEX_FAST=1|0 to override.`,
      );
    }
    return undefined;
  }

  serviceTierCache.set(configPath, { mtimeMs: cachedMtimeMs ?? 0, value: undefined });
  return undefined;
}

export function resolveCodexServiceTier(
  request: ProviderRequest,
  runtime?: Pick<ProviderRuntime<CodexExecutionPlan>, 'executionPlan' | 'storage'>,
): CodexServiceTier | undefined {
  const rawEnvTier = request.coralEnv['CORAL_CODEX_FAST'];
  // Blank env = unset; fall through to config.toml. Non-blank but unrecognized = explicit rejection (no fallback).
  if (rawEnvTier === undefined || rawEnvTier.trim() === '') {
    return runtime ? readCodexConfigServiceTier(runtime) : undefined;
  }
  return normalizeServiceTierEnv(rawEnvTier);
}

function resolveCodexModel(
  request: Pick<ProviderRequest, 'model' | 'coralEnv'>,
  catalog: CodexModelCatalog,
): ResolvedCodexModel {
  const baseline = request.coralEnv['CORAL_CODEX_MODEL'] ?? DEFAULT_CODEX_MODEL;
  const size =
    request.model !== undefined && Object.hasOwn(CODEX_ABSTRACT_MODEL, request.model)
      ? CODEX_ABSTRACT_MODEL[request.model]
      : undefined;
  if (size === undefined) return resolveCodexModelId(request.model ?? baseline, catalog);
  return resolveCodexModelId(isCodexSizedModel(baseline) ? size : baseline, catalog);
}

/** Thread creation or resume and every turn of one invocation must share one selection. */
export type CodexModelSelection = Readonly<{
  model: string;
  effort: EffortLevel;
  source:
    | { kind: 'catalog' }
    | { kind: 'pinned' }
    | { kind: 'built-in'; cause: 'size-unlisted'; size: CodexSize }
    | { kind: 'built-in'; cause: 'catalog-unavailable'; reason: string };
}>;

/** An abstract Coral tier must never reach the wire unmapped. */
export function resolveCodexSelection(request: ProviderRequest, catalog: CodexModelCatalog): CodexModelSelection {
  const resolved = resolveCodexModel(request, catalog);
  const supported = catalog.kind === 'listed' ? catalog.supportedEfforts.get(resolved.model) : undefined;
  const ceiling = highestKnownEffort(supported ?? []) ?? codexEffortCeiling(resolved.model);
  return { ...resolved, effort: resolveCodexEffort(request, resolved.model, ceiling) };
}

export function mapThreadStartParams(
  request: ProviderRequest,
  selection: CodexModelSelection,
  threadConfig: Readonly<Record<string, unknown>>,
  serviceTier?: CodexServiceTier,
): ThreadStartParams {
  return {
    cwd: request.cwd,
    model: selection.model,
    modelProvider: 'openai',
    approvalPolicy: 'never',
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    ephemeral: false,
    config: threadConfig,
    ...(serviceTier && { serviceTier }),
  };
}

export function mapThreadResumeParams(
  request: ProviderRequest,
  selection: CodexModelSelection,
  threadId: string,
  threadConfig: Readonly<Record<string, unknown>>,
  serviceTier?: CodexServiceTier,
): ThreadResumeParams {
  return {
    threadId,
    cwd: request.cwd,
    model: selection.model,
    modelProvider: 'openai',
    approvalPolicy: 'never',
    // Codex merge_persisted_resume_metadata() does not restore sandbox from stored
    // ThreadMetadata — omitting sandbox causes a downgrade to the config default (read-only).
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    config: threadConfig,
    ...(serviceTier && { serviceTier }),
  };
}

export function mapTurnStartParams(
  request: ProviderRequest,
  selection: CodexModelSelection,
  threadId: string,
  serviceTier?: CodexServiceTier,
): TurnStartParams {
  return {
    threadId,
    input: buildCodexTurnInput(buildCodexPrompt(request)),
    model: selection.model,
    effort: selection.effort,
    ...(serviceTier && { serviceTier }),
  };
}

export const CODEX_CAPACITY_CONTINUATION_PROMPT = `Continue the unanswered or partial response from the current thread.
Do not repeat prior work or restate the original prompt.
Continue from where you stopped.`;

export const CODEX_CYBER_POLICY_CONTINUATION_PROMPT = `Continue the unanswered or partial repository implementation from the current thread.
Keep the work strictly within defensive software quality: code correctness, robust input handling, bounded resource use, and regression tests in the user's own codebase.
Do not broaden the task beyond that scope.
Do not repeat prior work or restate the original prompt.
Continue from where you stopped.`;

export function mapRecoveryContinuationTurnStartParams(
  original: TurnStartParams,
  failure: RecoverableTurnFailure,
): TurnStartParams {
  const prompt =
    failure === 'cyberPolicy' ? CODEX_CYBER_POLICY_CONTINUATION_PROMPT : CODEX_CAPACITY_CONTINUATION_PROMPT;
  return {
    ...original,
    input: buildCodexTurnInput(prompt),
  };
}
