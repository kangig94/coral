import { join } from 'node:path';
import type {
  EffortLevel,
  ProviderContinuityUpdate,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerSpec,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { resolveModelTier, resolveProviderEffort } from '../request-policy.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { isRecord, readString } from '../../infra/json.js';
import type { ProviderTransportClose } from '../protocol.js';
import type { ThreadResumeParams, ThreadStartParams, TurnStartParams, UserInput } from './protocol.js';

type CodexServerSpecRequest = Pick<ProviderRequest, 'cwd' | 'coralEnv'>;

export interface CodexPersistedContinuity extends ProviderContinuityBlob {
  cwd?: string;
  threadId?: string;
  turnId?: string;
}

export function buildCodexPrompt(
  request: Pick<ProviderRequest, 'action' | 'instruction' | 'systemPrompt' | 'prompt'>,
): string {
  const parts: string[] = [];
  if (request.action !== 'resume' && request.instruction) {
    parts.push(request.instruction.content);
  }
  if (request.systemPrompt) {
    parts.push(request.systemPrompt);
  }
  parts.push(request.prompt);
  return parts.join('\n\n---\n\n');
}

// Codex ceiling is 'xhigh'; 'max' collapses to it.
const CODEX_EFFORT: Record<EffortLevel, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};
const CODEX_DEFAULT_EFFORT: EffortLevel = 'xhigh';
export type CodexServiceTier = 'fast' | 'flex';
const serviceTierCache = new Map<string, { mtimeMs: number; value: CodexServiceTier | undefined }>();

/**
 * Precedence: explicit request effort > CORAL_CODEX_EFFORT > CORAL_EFFORT >
 * Codex default (`xhigh`, matching the official guide).
 */
function resolveCodexEffort(request: ProviderRequest): EffortLevel {
  return resolveProviderEffort(request, 'CORAL_CODEX_EFFORT', request.coralEnv) ?? CODEX_DEFAULT_EFFORT;
}

function resolveCodexSandbox(bypassPermissions: boolean): 'workspace-write' | 'danger-full-access' {
  return bypassPermissions ? 'danger-full-access' : 'workspace-write';
}

export function readCodexPersistedContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): CodexPersistedContinuity {
  if (!isRecord(persistedContinuity)) {
    return {};
  }

  return {
    cwd: readString(persistedContinuity.cwd),
    threadId: readString(persistedContinuity.threadId),
    turnId: readString(persistedContinuity.turnId),
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
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

export function withCodexContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
  update: {
    cwd?: string;
    threadId?: string;
    turnId?: string;
  },
): CodexPersistedContinuity {
  const continuity = readCodexPersistedContinuity(persistedContinuity);
  return buildCodexContinuity({
    cwd: update.cwd ?? continuity.cwd,
    threadId: update.threadId ?? continuity.threadId,
    turnId: update.turnId ?? continuity.turnId,
  });
}

export function clearCodexTurnContinuity(
  persistedContinuity: ProviderContinuityBlob | undefined,
): CodexPersistedContinuity | undefined {
  const continuity = readCodexPersistedContinuity(persistedContinuity);
  if (!continuity.threadId) {
    return undefined;
  }

  return buildCodexContinuity({
    cwd: continuity.cwd,
    threadId: continuity.threadId,
  });
}

function hasCodexContinuity(continuity: CodexPersistedContinuity): boolean {
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
    const continuity = readCodexPersistedContinuity(envOrPersisted as ProviderContinuityBlob | undefined);
    return createCodexProviderServerSpec(
      continuity.cwd ?? projectRootOrRequest.cwd,
      projectRootOrRequest.coralEnv,
      clientVersion,
    );
  }

  return createCodexProviderServerSpec(
    projectRootOrRequest,
    envOrPersisted as Record<string, string> | undefined,
    clientVersion,
  );
}

export function buildCodexTurnInput(prompt: string): UserInput[] {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}

const DEFAULT_CODEX_MODEL = 'gpt-5.5';

function normalizeServiceTierEnv(value: string | undefined): CodexServiceTier | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized === '1') return 'fast';
  if (normalized === '0') return 'flex';
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
      const match = line.match(/^\s*service_tier\s*=\s*["']?(fast|flex)["']?\s*(#.*)?$/i);
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
        `Could not read service_tier from ~/.codex/config.toml: ${message}. Set CORAL_CODEX_FAST=fast|flex to override.`,
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

function resolveCodexModel(request: ProviderRequest): string {
  return resolveModelTier(request.model) ?? request.coralEnv['CORAL_CODEX_MODEL'] ?? DEFAULT_CODEX_MODEL;
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
  return {
    threadId,
    input: buildCodexTurnInput(buildCodexPrompt(request)),
    model: resolveCodexModel(request),
    effort: CODEX_EFFORT[resolveCodexEffort(request)],
    ...(serviceTier && { serviceTier }),
  };
}
