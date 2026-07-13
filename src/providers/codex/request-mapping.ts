import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  EffortLevel,
  ProviderContinuityUpdate,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerSpec,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { pickProviderContinuityKeys } from '../middleware/session-continuity.js';
import { resolveModelTier, resolveProviderEffort } from '../request-policy.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { isRecord, readString } from '../../infra/json.js';
import type { ProviderTransportClose } from '../protocol.js';
import type { ThreadResumeParams, ThreadStartParams, TurnStartParams, UserInput } from './protocol.js';

type CodexServerSpecRequest = Pick<ProviderRequest, 'cwd' | 'coralEnv' | 'secretEnv'>;

const CODEX_CONTINUITY_KEYS = ['cwd', 'threadId', 'turnId'] as const;
const codexContinuityCwdScopes = new WeakMap<Record<string, unknown>, string>();

export interface CodexPersistedContinuity extends ProviderContinuityBlob {
  cwd?: string;
  threadId?: string;
  turnId?: string;
}

type CodexContinuityReadOptions = {
  allowUnscopedCwd?: boolean;
  cwdScope?: string;
};

/**
 * Assemble the single Codex turn text.
 *
 * Order is presentation-only (Codex has no separate system channel): guidelines /
 * systemPrompt first, then agent instruction, then the user task. `INJECT.md` is
 * pre-merged into `systemPrompt` by `applyInjectMd` at the job shell boundary.
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
/**
 * Effort ceilings by Codex model line:
 * - Sol/Terra (GPT-5.6): up to `ultra`
 * - Luna (GPT-5.6): up to `max` (no ultra)
 * - older lines (e.g. gpt-5.5): up to `xhigh`
 */
const CODEX_GPT56_EFFORT_CEILING: EffortLevel = 'ultra';
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
  if (!isCodexGpt56Family(model)) {
    return CODEX_LEGACY_EFFORT_CEILING;
  }
  if (isCodexLuna(model)) {
    return CODEX_LUNA_EFFORT_CEILING;
  }
  return CODEX_GPT56_EFFORT_CEILING;
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

/**
 * Precedence: explicit request effort > CORAL_CODEX_EFFORT > CORAL_EFFORT >
 * Coral default (`high`). Then clamp:
 * - Terra/Luna floor: `xhigh`
 * - Sol/Terra ceiling: `ultra`
 * - Luna ceiling: `max` (no ultra)
 * - older lines (e.g. gpt-5.5) ceiling: `xhigh`
 */
function resolveCodexEffort(request: ProviderRequest, model: string): EffortLevel {
  const resolved = resolveProviderEffort(request, 'CORAL_CODEX_EFFORT', request.coralEnv) ?? CODEX_DEFAULT_EFFORT;
  const floor = isCodexTerraOrLuna(model) ? CODEX_TERRA_LUNA_MIN_EFFORT : undefined;
  return clampEffort(resolved, floor, codexEffortCeiling(model));
}

function resolveCodexSandbox(bypassPermissions: boolean): 'workspace-write' | 'danger-full-access' {
  return bypassPermissions ? 'danger-full-access' : 'workspace-write';
}

export function readCodexPersistedContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  options: CodexContinuityReadOptions = {},
): CodexPersistedContinuity {
  if (!isRecord(persistedContinuity)) {
    return {};
  }

  const continuity = pickProviderContinuityKeys(persistedContinuity, CODEX_CONTINUITY_KEYS);
  const cwdScope = readString(options.cwdScope) ?? codexContinuityCwdScopes.get(persistedContinuity);
  const cwd = readString(continuity.cwd);
  const parsed = {
    cwd:
      cwdScope === undefined && options.allowUnscopedCwd !== false
        ? cwd === undefined
          ? undefined
          : resolve(cwd)
        : scopedCodexCwd(cwd, cwdScope),
    threadId: readString(continuity.threadId),
    turnId: readString(continuity.turnId),
  };
  rememberCodexContinuityCwdScope(parsed, parsed.cwd);
  return parsed;
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
  rememberCodexContinuityCwdScope(continuity, continuity.cwd);
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

export function snapshotCodexPersistedContinuity(persistedContinuity: ProviderContinuityBlob | undefined): {
  conversationRef: string | null;
  resumable: boolean;
  providerContinuity: CodexPersistedContinuity | null;
} {
  const continuity = readCodexPersistedContinuity(persistedContinuity);
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

  return readCodexPersistedContinuity(persistedContinuity);
}

export function applyCodexTransportClosed(
  persistedContinuity: CodexPersistedContinuity,
  _closed: ProviderTransportClose,
): CodexPersistedContinuity {
  return readCodexPersistedContinuity(persistedContinuity);
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

function createCodexProviderServerSpec(
  projectRoot: string,
  env?: Record<string, string>,
  clientVersion?: string,
): ProviderServerSpec {
  return {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: projectRoot,
    env,
    // codex app-server handles concurrent threads per process — each turn carries its own
    // threadId, so a shared lease (many concurrent leases on one host) matches reality.
    // Without this, host-manager forces exclusive leases and serializes concurrent codex jobs.
    shared: true,
    initializeRequest: {
      method: 'initialize',
      params: { clientInfo: { name: 'coral', version: clientVersion ?? 'unknown' } },
    },
  };
}

function rememberCodexContinuityCwdScope(
  persistedContinuity: ProviderContinuityBlob | undefined,
  cwdScope: string | undefined,
): void {
  const normalizedScope = readString(cwdScope);
  if (!normalizedScope || !isRecord(persistedContinuity)) {
    return;
  }
  codexContinuityCwdScopes.set(persistedContinuity, resolve(normalizedScope));
}

function scopedCodexCwd(cwd: string | undefined, cwdScope: string | undefined): string | undefined {
  if (cwd === undefined || cwdScope === undefined) {
    return undefined;
  }

  const resolvedScope = resolve(cwdScope);
  const resolvedCwd = resolve(cwd);
  const scopedRelative = relative(resolvedScope, resolvedCwd);
  if (
    scopedRelative === '' ||
    (!scopedRelative.startsWith(`..${sep}`) && scopedRelative !== '..' && !isAbsolute(scopedRelative))
  ) {
    return resolvedCwd;
  }
  return undefined;
}

export function buildCodexProviderServerSpec(
  projectRoot: string,
  env?: Record<string, string>,
  clientVersion?: string,
): ProviderServerSpec;
export function buildCodexProviderServerSpec(
  request: CodexServerSpecRequest,
  persistedContinuity?: ProviderContinuityBlob,
  clientVersion?: string,
): ProviderServerSpec;
export function buildCodexProviderServerSpec(
  projectRootOrRequest: string | CodexServerSpecRequest,
  envOrPersisted?: Record<string, string> | ProviderContinuityBlob,
  clientVersion?: string,
): ProviderServerSpec {
  if (typeof projectRootOrRequest !== 'string') {
    const persistedContinuity = envOrPersisted as ProviderContinuityBlob | undefined;
    rememberCodexContinuityCwdScope(persistedContinuity, projectRootOrRequest.cwd);
    const continuity = readCodexPersistedContinuity(persistedContinuity, { cwdScope: projectRootOrRequest.cwd });
    return createCodexProviderServerSpec(
      continuity.cwd ?? projectRootOrRequest.cwd,
      { ...projectRootOrRequest.coralEnv, ...projectRootOrRequest.secretEnv },
      clientVersion,
    );
  }

  return createCodexProviderServerSpec(
    projectRootOrRequest,
    envOrPersisted as Record<string, string> | undefined,
    clientVersion,
  );
}

function buildCodexTurnInput(prompt: string): UserInput[] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';

/**
 * Canonical GPT-5.6 size model ids, keyed by their bare size alias. Single home
 * for the `gpt-5.6-<size>` literals: the abstract-tier map, the family check, and
 * the bare-alias normalization in `resolveCodexModel` all derive from this.
 */
const GPT56_SIZE_MODEL: Record<string, string> = {
  sol: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
};

function normalizeGpt56SizeAlias(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const key = model.trim().toLowerCase();
  return Object.hasOwn(GPT56_SIZE_MODEL, key) ? GPT56_SIZE_MODEL[key] : model;
}

/**
 * Agent frontmatter / Coral abstract tiers → Codex GPT-5.6 family aliases.
 * Agent files declare Claude-style tiers (`opus` / `sonnet` / `haiku`); Codex
 * consumes the generation-family names gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna instead.
 *
 * Only applied when the configured baseline model is a GPT-5.6 family id.
 * Older single-size lines (e.g. `gpt-5.5`) have no sol/terra/luna split, so
 * abstract tiers collapse to that one baseline model.
 */
const CODEX_ABSTRACT_MODEL: Record<string, string> = {
  opus: GPT56_SIZE_MODEL.sol,
  sonnet: GPT56_SIZE_MODEL.terra,
  haiku: GPT56_SIZE_MODEL.luna,
};

/** True when `model` is a GPT-5.6 generation id (or bare sol/terra/luna alias). */
function isCodexGpt56Family(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('gpt-5.6')) return true;
  return GPT56_SIZE_MODEL[normalized] !== undefined;
}

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
 * Read `service_tier` from the top level of ~/.codex/config.toml.
 * Profile-scoped values under `[profiles.xxx]` are intentionally ignored —
 * the scan halts at the first section header.
 */
function readCodexConfigServiceTier(runtime: Pick<ProviderRuntime, 'env' | 'storage'>): CodexServiceTier | undefined {
  if (!runtime.env || !runtime.storage) {
    return undefined;
  }

  const configPath = join(runtime.env.homedir(), '.codex', 'config.toml');
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
        `Could not read service_tier from ~/.codex/config.toml: ${message}. Set CORAL_CODEX_FAST=1|0 to override.`,
      );
    }
    return undefined;
  }

  serviceTierCache.set(configPath, { mtimeMs: cachedMtimeMs ?? 0, value: undefined });
  return undefined;
}

export function resolveCodexServiceTier(
  request: ProviderRequest,
  runtime?: Pick<ProviderRuntime, 'env' | 'storage'>,
): CodexServiceTier | undefined {
  const rawEnvTier = request.coralEnv['CORAL_CODEX_FAST'];
  // Blank env = unset; fall through to config.toml. Non-blank but unrecognized = explicit rejection (no fallback).
  if (rawEnvTier === undefined || rawEnvTier.trim() === '') {
    return runtime ? readCodexConfigServiceTier(runtime) : undefined;
  }
  return normalizeServiceTierEnv(rawEnvTier);
}

/**
 * Resolve the model id sent on Codex wire params.
 *
 * Precedence:
 * 1. Abstract tier (`opus`/`sonnet`/`haiku`):
 *    - GPT-5.6 baseline → map to `gpt-5.6-sol`/`-terra`/`-luna`
 *    - otherwise → collapse to the baseline as-is (no size split)
 * 2. Bare GPT-5.6 size alias (`sol`/`terra`/`luna`) → canonical `gpt-5.6-<size>`
 * 3. Concrete request.model (pass-through)
 * 4. CORAL_CODEX_MODEL
 * 5. DEFAULT_CODEX_MODEL
 *
 * Baseline = CORAL_CODEX_MODEL ?? DEFAULT. Abstract tiers must resolve here —
 * `resolveModelTier` returns undefined for them so Claude can defer to CLI
 * aliases; Codex has no equivalent for those Claude-style names.
 */
function resolveCodexModel(request: ProviderRequest): string {
  const baseline = normalizeGpt56SizeAlias(request.coralEnv['CORAL_CODEX_MODEL']) ?? DEFAULT_CODEX_MODEL;

  if (request.model !== undefined) {
    const mapped = Object.hasOwn(CODEX_ABSTRACT_MODEL, request.model) ? CODEX_ABSTRACT_MODEL[request.model] : undefined;
    if (mapped !== undefined) {
      return isCodexGpt56Family(baseline) ? mapped : baseline;
    }
    // Bare GPT-5.6 size aliases (sol/terra/luna) are concrete model requests, not
    // abstract tiers: normalize to the canonical `gpt-5.6-<size>` id so the wire
    // model (and Codex) never sees the prefix-less alias. Unconditional — these
    // names are explicit 5.6 sizes regardless of the baseline line.
    const sizeModel = normalizeGpt56SizeAlias(request.model) ?? request.model;
    if (sizeModel !== request.model) {
      return sizeModel;
    }
  }
  return resolveModelTier(request.model) ?? baseline;
}

export function mapThreadStartParams(request: ProviderRequest, serviceTier?: CodexServiceTier): ThreadStartParams {
  return {
    cwd: request.cwd,
    model: resolveCodexModel(request),
    approvalPolicy: 'never',
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    ephemeral: false,
    ...(serviceTier && { serviceTier }),
  };
}

export function mapThreadResumeParams(
  request: ProviderRequest,
  threadId: string,
  serviceTier?: CodexServiceTier,
): ThreadResumeParams {
  return {
    threadId,
    cwd: request.cwd,
    model: resolveCodexModel(request),
    approvalPolicy: 'never',
    // Codex merge_persisted_resume_metadata() does not restore sandbox from stored
    // ThreadMetadata — omitting sandbox causes a downgrade to the config default (read-only).
    sandbox: resolveCodexSandbox(request.bypassPermissions),
    ...(serviceTier && { serviceTier }),
  };
}

export function mapTurnStartParams(
  request: ProviderRequest,
  threadId: string,
  serviceTier?: CodexServiceTier,
): TurnStartParams {
  const model = resolveCodexModel(request);
  return {
    threadId,
    input: buildCodexTurnInput(buildCodexPrompt(request)),
    model,
    effort: resolveCodexEffort(request, model),
    ...(serviceTier && { serviceTier }),
  };
}
