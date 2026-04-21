import { join } from 'node:path';
import type { ProviderEventBody, ProviderRequest } from '../protocol.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { readString } from '../../shared/utils.js';
import { runAppServerTurn } from '../app-server/runner.js';
import {
  type PreflightRuntime,
  type ProviderAppServerLifecycle,
  type ProviderRuntime,
  type ProviderServerLease,
  type Provider,
} from '../provider-contracts.js';
import {
  buildCodexProviderServerSpec,
} from './request-mapping.js';
import { codexSessionDriver } from './session-driver.js';
import type { AppServerMethod, AppServerRequestParams, AppServerResponse } from './protocol.js';

const CODEX_APP_SERVER_UPGRADE_MESSAGE = 'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE = 'Codex CLI is not authenticated. Run "codex login" to create ~/.codex/auth.json.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;

type CodexContinuity = {
  cwd?: string;
  threadId?: string;
  turnId?: string;
};

type PreflightCacheEntry = {
  available: boolean;
  checkedAt: number;
};

let codexAppServerAvailabilityCache: PreflightCacheEntry | null = null;
let codexAuthTokensCache: PreflightCacheEntry | null = null;

function isMissingConversationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('missing thread') ||
    message.includes('unknown thread') ||
    message.includes('does not exist') ||
    message.includes('no such thread')
  );
}

function toCodexContinuity(continuity: ProviderContinuityBlob | undefined): CodexContinuity {
  return {
    cwd: readString(continuity?.cwd),
    threadId: readString(continuity?.threadId),
    turnId: readString(continuity?.turnId),
  };
}

function continuityWithClearedTurnId(continuity: ProviderContinuityBlob | undefined): ProviderContinuityBlob | undefined {
  const { cwd, threadId } = toCodexContinuity(continuity);
  if (!threadId) {
    return undefined;
  }
  return {
    ...(cwd ? { cwd } : {}),
    threadId,
  };
}

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
  if (!value || typeof value !== 'object') return false;
  const tokens = (value as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== 'object') return false;

  return ['access_token', 'refresh_token', 'id_token'].some((key) => {
    const token = (tokens as Record<string, unknown>)[key];
    return typeof token === 'string' && token.trim().length > 0;
  });
}

export const codexAppServerLifecycle: ProviderAppServerLifecycle = {
  migrateLegacyContinuity(meta) {
    const continuity: ProviderContinuityBlob = {};
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
  buildServerSpec(persistedContinuity, request) {
    const { cwd } = toCodexContinuity(persistedContinuity);
    return buildCodexProviderServerSpec(cwd ?? request.cwd, request.coralEnv);
  },
  async interrupt(lease, continuity) {
    const parsed = toCodexContinuity(continuity);
    if (!parsed.threadId || !parsed.turnId) {
      return;
    }
    await interruptTurn(lease, parsed.threadId, parsed.turnId);
  },
  async probe(lease, continuity) {
    const parsed = toCodexContinuity(continuity);
    const updatedContinuity = continuityWithClearedTurnId(continuity);
    if (!parsed.threadId) {
      return { resumable: false, updatedContinuity };
    }

    try {
      // Probe only checks thread existence — sandbox is intentionally omitted because
      // no commands execute during probe, so the sandbox policy is irrelevant.
      // Infrastructure: probe uses process.cwd() for orphaned continuity data without request context
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
      if (!isMissingConversationError(error)) {
        throw error;
      }
      return {
        resumable: false,
        updatedContinuity,
      };
    }
  },
  finalizeInterrupted(probeResult, continuity) {
    const nextContinuity = probeResult.updatedContinuity ?? continuityWithClearedTurnId(continuity);
    const parsed = toCodexContinuity(nextContinuity ?? continuity);
    if (probeResult.resumable && parsed.threadId) {
      return {
        conversationRef: parsed.threadId,
        ...(nextContinuity ? { continuityMutation: nextContinuity } : {}),
      };
    }
    return {
      nonResumable: true,
      ...(nextContinuity ? { continuityMutation: nextContinuity } : {}),
    };
  },
};

function runCodex(request: ProviderRequest, runtime: ProviderRuntime): AsyncIterable<ProviderEventBody> {
  if (request.action === 'fork') {
    throw new Error('Codex app-server fork is unsupported until clone/fork RPC is available.');
  }
  return runAppServerTurn(codexSessionDriver, request, runtime);
}

const codexProviderBase = Object.assign(function codex(request: ProviderRequest, runtime: ProviderRuntime) {
  return runCodex(request, runtime);
}, {
  preflight: codexPreflight,
  appServerLifecycle: codexAppServerLifecycle,
});

export const codexProvider = Object.assign(codexProviderBase, {
  execute: codexProviderBase,
}) satisfies Provider & { appServerLifecycle: ProviderAppServerLifecycle };
