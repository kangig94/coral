import { join } from 'node:path';

import type {
  PreflightRuntime,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderServerLease,
} from '../contract.js';
import type { AppServerMethod, AppServerRequestParams, AppServerResponse } from './protocol.js';
import {
  buildCodexProviderServerSpec,
  clearCodexTurnContinuity,
  isCodexSessionUnavailable,
  readCodexPersistedContinuity,
} from './request-mapping.js';

const CODEX_APP_SERVER_UPGRADE_MESSAGE =
  'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE =
  'Codex CLI is not authenticated. Run "codex login" to create ~/.codex/auth.json.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;

type PreflightCacheEntry = {
  available: boolean;
  checkedAt: number;
};

let codexAppServerAvailabilityCache: PreflightCacheEntry | null = null;
let codexAuthTokensCache: PreflightCacheEntry | null = null;

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

export async function codexPreflight(runtime: PreflightRuntime): Promise<void> {
  await assertCodexAppServerAvailable(runtime);
  await assertCodexAuthTokens(runtime);
}

async function assertCodexAppServerAvailable(runtime: PreflightRuntime): Promise<void> {
  const now = Date.now();
  if (codexAppServerAvailabilityCache && now - codexAppServerAvailabilityCache.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    if (!codexAppServerAvailabilityCache.available) {
      throw new Error(CODEX_APP_SERVER_UPGRADE_MESSAGE);
    }
    return;
  }

  const result = await runtime.process.exec('codex', ['app-server', '--help'], {
    encoding: 'utf-8',
    timeout: 10_000,
    inheritEnv: true,
  });
  const available = !result.error && result.status === 0;
  codexAppServerAvailabilityCache = { available, checkedAt: now };
  if (!available) {
    throw new Error(CODEX_APP_SERVER_UPGRADE_MESSAGE);
  }
}

async function assertCodexAuthTokens(runtime: PreflightRuntime): Promise<void> {
  const now = Date.now();
  if (codexAuthTokensCache && now - codexAuthTokensCache.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    if (!codexAuthTokensCache.available) {
      throw new Error(CODEX_AUTH_ERROR_MESSAGE);
    }
    return;
  }

  const authPath = join(runtime.env.homedir(), '.codex', 'auth.json');
  let parsed: unknown;

  try {
    parsed = JSON.parse(runtime.storage.readFileSync(authPath, 'utf-8')) as unknown;
  } catch {
    codexAuthTokensCache = { available: false, checkedAt: now };
    throw new Error(CODEX_AUTH_ERROR_MESSAGE);
  }

  const available = hasCodexAuthTokens(parsed);
  codexAuthTokensCache = { available, checkedAt: now };
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

  return ['access_token', 'refresh_token', 'id_token'].some((key) => {
    const token = (tokens as Record<string, unknown>)[key];
    return typeof token === 'string' && token.trim().length > 0;
  });
}

export const codexAppServerLifecycle: ProviderAppServerContract = {
  name: 'codex',
  subscriptionPhase: 'afterInitialize',
  buildServerSpec(request, persistedContinuity) {
    return buildCodexProviderServerSpec(request, persistedContinuity);
  },
  async interrupt(lease, continuity) {
    const parsed = readCodexPersistedContinuity(continuity);
    if (!parsed.threadId || !parsed.turnId) {
      return;
    }
    await interruptTurn(lease, parsed.threadId, parsed.turnId);
  },
};

export const codexRecoveryLifecycle = {
  migrateLegacyContinuity(meta) {
    const continuity: Record<string, unknown> = {};
    if (typeof meta.provider === 'string' && meta.provider.length > 0) {
      continuity.provider = meta.provider;
    }
    if (typeof meta.threadId === 'string' && meta.threadId.length > 0) {
      continuity.threadId = meta.threadId;
    }
    if (typeof meta.turnId === 'string' && meta.turnId.length > 0) {
      continuity.turnId = meta.turnId;
    }
    return Object.keys(continuity).length > 0 ? continuity : undefined;
  },
  async probe(lease, continuity) {
    const parsed = readCodexPersistedContinuity(continuity);
    const updatedContinuity = clearCodexTurnContinuity(continuity);
    if (!parsed.threadId) {
      return { resumable: false, updatedContinuity };
    }

    try {
      await rpc(lease, 'thread/resume', {
        threadId: parsed.threadId,
        cwd: parsed.cwd ?? process.cwd(),
        model: null,
        approvalPolicy: 'never',
      });
      return {
        resumable: true,
        updatedContinuity,
      };
    } catch (error) {
      if (!isCodexSessionUnavailable(error)) {
        throw error;
      }
      return {
        resumable: false,
        updatedContinuity,
      };
    }
  },
  finalizeInterrupted(probeResult, continuity, context) {
    const nextContinuity = probeResult.updatedContinuity ?? clearCodexTurnContinuity(continuity);
    const parsed = readCodexPersistedContinuity(nextContinuity ?? continuity);
    const effectiveConversationRef = parsed.threadId ?? context.preservedConversationRef;
    if (probeResult.resumable && effectiveConversationRef) {
      return {
        type: 'set_resumable',
        conversationRef: effectiveConversationRef,
        ...(nextContinuity ? { providerContinuity: nextContinuity } : {}),
      };
    }

    if (probeResult.resumable) {
      return {
        type: 'preserve',
        ...(nextContinuity ? { providerContinuity: nextContinuity } : {}),
      };
    }

    return {
      type: 'clear_non_resumable',
      ...(nextContinuity ? { providerContinuity: nextContinuity } : {}),
    };
  },
} satisfies Pick<ProviderRecoveryContract, 'probe' | 'finalizeInterrupted' | 'migrateLegacyContinuity'>;
