import { join } from 'node:path';

import type {
  ProviderPreflightRuntime,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderServerLease,
  ProviderServerSpec,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { SessionContinuityMutation } from '../../sessions/continuity-mutation.js';
import { readString } from '../../infra/json.js';
import type { AppServerMethod, AppServerRequestParams, AppServerResponse } from './protocol.js';
import {
  buildCodexProviderServerSpec,
  clearCodexTurnContinuity,
  hasCodexContinuity,
  isCodexSessionUnavailable,
  type CodexPersistedContinuity,
  readCodexPersistedContinuity,
} from './request-mapping.js';

const CODEX_APP_SERVER_UPGRADE_MESSAGE =
  'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE =
  'The selected Codex account is not authenticated. Run "codex login" with the same CODEX_HOME and retry.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;
const CODEX_AUTH_TOKEN_KEYS = ['access_token', 'refresh_token', 'id_token'] as const;
const SCOPED_CODEX_CONTINUITY_READ = { allowUnscopedCwd: false } as const;

type PreflightCacheEntry = {
  available: boolean;
  checkedAt: number;
};

let codexAppServerAvailabilityCache: PreflightCacheEntry | null = null;
const codexAuthTokensCache = new Map<string, PreflightCacheEntry>();

async function rpc<M extends AppServerMethod>(
  lease: ProviderServerLease,
  method: M,
  params: AppServerRequestParams<M>,
): Promise<AppServerResponse<M>> {
  return lease.rpc<AppServerResponse<M>>(method, params as unknown as Record<string, unknown>);
}

async function interruptTurn(lease: ProviderServerLease, threadId: string, turnId: string): Promise<void> {
  await rpc(lease, 'turn/interrupt', { threadId, turnId });
}

type CodexRecoveryMeta = {
  threadId?: string;
};

type CodexProbeResult = {
  resumable: boolean;
  updatedContinuity?: ProviderContinuityBlob;
};

function codexProbeResult(resumable: boolean, updatedContinuity: ProviderContinuityBlob | undefined): CodexProbeResult {
  return updatedContinuity === undefined ? { resumable } : { resumable, updatedContinuity };
}

function sanitizeCodexProviderContinuity(
  continuity: ProviderContinuityBlob | undefined,
): CodexPersistedContinuity | undefined {
  const parsed = readCodexPersistedContinuity(continuity, SCOPED_CODEX_CONTINUITY_READ);
  return hasCodexContinuity(parsed) ? parsed : undefined;
}

export async function codexPreflight(runtime: ProviderPreflightRuntime): Promise<void> {
  if (runtime.credentialSource.provider !== 'codex') throw new Error('Codex credential source required.');
  await assertCodexAppServerAvailable(runtime);
  await assertCodexAuthTokens(runtime);
}

async function assertCodexAppServerAvailable(runtime: ProviderPreflightRuntime): Promise<void> {
  const now = runtime.time.now();
  if (
    codexAppServerAvailabilityCache &&
    now - codexAppServerAvailabilityCache.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS
  ) {
    if (!codexAppServerAvailabilityCache.available) {
      throw new Error(CODEX_APP_SERVER_UPGRADE_MESSAGE);
    }
    return;
  }

  const result = await runtime.runExact('codex', ['app-server', '--help'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  const available = !result.error && result.status === 0;
  codexAppServerAvailabilityCache = { available, checkedAt: now };
  if (!available) {
    throw new Error(CODEX_APP_SERVER_UPGRADE_MESSAGE);
  }
}

async function assertCodexAuthTokens(runtime: ProviderPreflightRuntime): Promise<void> {
  const now = runtime.time.now();
  if (runtime.credentialSource.provider !== 'codex') throw new Error('Codex credential source required.');
  const cacheKey = runtime.credentialSource.home;
  const cached = codexAuthTokensCache.get(cacheKey);
  if (cached && now - cached.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    if (!cached.available) {
      throw new Error(CODEX_AUTH_ERROR_MESSAGE);
    }
    return;
  }

  const authPath = join(runtime.credentialSource.home, 'auth.json');
  let parsed: unknown;

  try {
    parsed = JSON.parse(runtime.storage.readFileSync(authPath, 'utf-8')) as unknown;
  } catch {
    codexAuthTokensCache.set(cacheKey, { available: false, checkedAt: now });
    throw new Error(CODEX_AUTH_ERROR_MESSAGE);
  }

  const available = hasCodexAuthTokens(parsed);
  codexAuthTokensCache.set(cacheKey, { available, checkedAt: now });
  if (!available) {
    throw new Error(CODEX_AUTH_ERROR_MESSAGE);
  }
}

function hasCodexAuthTokens(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const tokens = (value as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== 'object') {
    return false;
  }

  return CODEX_AUTH_TOKEN_KEYS.some((key) => {
    const token = (tokens as Record<string, unknown>)[key];
    return typeof token === 'string' && token.trim().length > 0;
  });
}

export const codexAppServerLifecycle: ProviderAppServerContract = {
  name: 'codex',
  subscriptionPhase: 'afterInitialize',
  buildServerSpec(
    request: ProviderRequest,
    persistedContinuity: ProviderContinuityBlob | undefined,
    _ports,
    providerContext,
  ): ProviderServerSpec {
    if (providerContext.provider !== 'codex') throw new Error('Codex provider context required.');
    return { ...buildCodexProviderServerSpec(request, persistedContinuity), env: { ...providerContext.appServerEnv } };
  },
  async interrupt(lease: ProviderServerLease, continuity: ProviderContinuityBlob): Promise<void> {
    const parsed = readCodexPersistedContinuity(continuity);
    if (parsed.threadId === undefined || parsed.turnId === undefined) {
      return;
    }
    await interruptTurn(lease, parsed.threadId, parsed.turnId);
  },
};

export const codexRecoveryLifecycle = {
  buildRecoveryMeta(request: ProviderRequest): CodexRecoveryMeta {
    const conversationRef = readString(request.conversationRef);
    return conversationRef !== undefined ? { threadId: conversationRef } : {};
  },
  async probe(lease: ProviderServerLease, continuity: ProviderContinuityBlob): Promise<CodexProbeResult> {
    const parsed = readCodexPersistedContinuity(continuity, SCOPED_CODEX_CONTINUITY_READ);
    const updatedContinuity = clearCodexTurnContinuity(continuity, SCOPED_CODEX_CONTINUITY_READ);
    if (parsed.threadId === undefined || parsed.cwd === undefined) {
      return codexProbeResult(false, updatedContinuity);
    }

    try {
      await rpc(lease, 'thread/resume', {
        threadId: parsed.threadId,
        cwd: parsed.cwd,
        model: null,
        approvalPolicy: 'never',
      });
      return codexProbeResult(true, updatedContinuity);
    } catch (error) {
      if (!isCodexSessionUnavailable(error)) {
        throw error;
      }
      return codexProbeResult(false, updatedContinuity);
    }
  },
  finalizeInterrupted(
    probeResult: CodexProbeResult,
    continuity: ProviderContinuityBlob,
    context: { preservedConversationRef?: string },
  ): SessionContinuityMutation {
    const nextContinuity = sanitizeCodexProviderContinuity(
      probeResult.updatedContinuity ?? clearCodexTurnContinuity(continuity, SCOPED_CODEX_CONTINUITY_READ),
    );
    const parsed = readCodexPersistedContinuity(nextContinuity ?? continuity);
    const effectiveConversationRef = parsed.threadId ?? context.preservedConversationRef;
    if (probeResult.resumable && effectiveConversationRef !== undefined) {
      return {
        kind: 'set_resumable',
        conversationRef: effectiveConversationRef,
        ...(nextContinuity ? { providerContinuity: nextContinuity } : {}),
      };
    }

    if (probeResult.resumable) {
      return {
        kind: 'preserve',
        ...(nextContinuity ? { providerContinuity: nextContinuity } : {}),
      };
    }

    return {
      kind: 'clear_non_resumable',
      ...(nextContinuity ? { providerContinuity: nextContinuity } : {}),
    };
  },
} satisfies Pick<ProviderRecoveryContract, 'buildRecoveryMeta' | 'probe' | 'finalizeInterrupted'>;
