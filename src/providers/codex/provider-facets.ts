import { join } from 'node:path';

import type {
  ProviderPreflightRuntime,
  ProviderAppServerCapability,
  AppServerTransport,
  ProviderRecoveryContract,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { SessionContinuityMutation } from '../../sessions/continuity-mutation.js';
import type { AppServerMethod, AppServerRequestParams, AppServerResponse } from './protocol.js';
import {
  clearCodexTurnContinuity,
  hasCodexContinuity,
  isCodexSessionUnavailable,
  type CodexPersistedContinuity,
  readCodexPersistedContinuity,
} from './request-mapping.js';
import { verifyCodexEffectiveTransport } from './transport-policy.js';
import {
  buildCodexHost,
  codexChildShellEnvironmentPolicy,
  compileCodexHostEnvironment,
  type CodexProviderAccess,
  type CodexExecutionPlan,
} from './execution-plan.js';
import { windowsCommandName } from '../../infra/windows-shell.js';

const CODEX_APP_SERVER_UPGRADE_MESSAGE =
  'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE =
  'The selected Codex account is not authenticated. Run "codex login" with the same CODEX_HOME and retry.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;
const CODEX_AUTH_TOKEN_KEYS = ['access_token', 'refresh_token', 'id_token'] as const;

type PreflightCacheEntry = {
  available: boolean;
  checkedAt: number;
};

let codexAppServerAvailabilityCache: PreflightCacheEntry | null = null;
const codexAuthTokensCache = new Map<string, PreflightCacheEntry>();

async function rpc<M extends AppServerMethod>(
  lease: AppServerTransport,
  method: M,
  params: AppServerRequestParams<M>,
): Promise<AppServerResponse<M>> {
  return lease.rpc<AppServerResponse<M>>(method, params as unknown as Record<string, unknown>);
}

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
  const parsed = readCodexPersistedContinuity(continuity);
  return hasCodexContinuity(parsed) ? parsed : undefined;
}

export async function codexPreflight(runtime: ProviderPreflightRuntime<CodexProviderAccess>): Promise<void> {
  await assertCodexAppServerAvailable(runtime);
  await assertCodexAuthTokens(runtime);
}

async function assertCodexAppServerAvailable(runtime: ProviderPreflightRuntime<CodexProviderAccess>): Promise<void> {
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

async function assertCodexAuthTokens(runtime: ProviderPreflightRuntime<CodexProviderAccess>): Promise<void> {
  const now = runtime.time.now();
  const cacheKey = runtime.access.home;
  const cached = codexAuthTokensCache.get(cacheKey);
  if (cached && now - cached.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    if (!cached.available) {
      throw new Error(CODEX_AUTH_ERROR_MESSAGE);
    }
    return;
  }

  const authPath = join(runtime.access.home, 'auth.json');
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

export const codexAppServerLifecycle: ProviderAppServerCapability<CodexExecutionPlan, CodexProviderAccess> = {
  name: 'codex',
  planHost: (input) => {
    if (input.purpose !== 'execution') throw new Error('Codex does not support curation hosts.');
    return buildCodexHost({
      access: input.access,
      request: input.request,
      persistedContinuity: input.persistedContinuity,
      baseEnv: input.baseEnv,
      platform: input.platform,
    });
  },
  compileStableHost: (host) => ({
    provider: 'codex',
    command: windowsCommandName(host.command, host.platform),
    args: [...host.args],
    cwd: host.cwd,
    env: { ...compileCodexHostEnvironment(host) },
    leaseMode: host.leaseMode,
    idlePolicy: 'daemon',
    initializeRequest: {
      method: 'initialize',
      params: { clientInfo: { name: 'coral', version: 'unknown' } },
    },
  }),
  async interrupt(lease: AppServerTransport, continuity: ProviderContinuityBlob): Promise<boolean> {
    const parsed = readCodexPersistedContinuity(continuity);
    if (parsed.threadId === undefined || parsed.turnId === undefined) {
      return false;
    }
    const result = await rpc(lease, 'turn/interrupt', { threadId: parsed.threadId, turnId: parsed.turnId });
    return result.threadId === parsed.threadId && result.turnId === parsed.turnId;
  },
  async probe(lease, continuity, context): Promise<CodexProbeResult> {
    return probeCodexSession(lease, continuity, context.request.cwd);
  },
};

async function probeCodexSession(
  lease: AppServerTransport,
  continuity: ProviderContinuityBlob,
  cwdScope: string,
): Promise<CodexProbeResult> {
  const parsed = readCodexPersistedContinuity(continuity, { cwdScope });
  const updatedContinuity = clearCodexTurnContinuity(continuity, { cwdScope });
  if (parsed.threadId === undefined || parsed.cwd === undefined) {
    return codexProbeResult(false, updatedContinuity);
  }

  try {
    await verifyCodexEffectiveTransport(lease, parsed.cwd);
    const response = await rpc(lease, 'thread/resume', {
      threadId: parsed.threadId,
      cwd: parsed.cwd,
      model: null,
      modelProvider: 'openai',
      approvalPolicy: 'never',
      config: { shell_environment_policy: codexChildShellEnvironmentPolicy() },
    });
    if (response.thread?.id !== parsed.threadId) {
      throw new Error('Codex recovery probe did not resume the exact requested thread id.');
    }
    return codexProbeResult(true, updatedContinuity);
  } catch (error) {
    if (!isCodexSessionUnavailable(error)) {
      throw error;
    }
    return codexProbeResult(false, updatedContinuity);
  }
}

export const codexRecoveryLifecycle = {
  finalizeInterrupted(
    probeResult: CodexProbeResult,
    continuity: ProviderContinuityBlob | undefined,
    context: { preservedConversationRef?: string },
  ): SessionContinuityMutation {
    const nextContinuity = sanitizeCodexProviderContinuity(
      probeResult.updatedContinuity ?? (continuity === undefined ? undefined : clearCodexTurnContinuity(continuity)),
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
} satisfies Pick<ProviderRecoveryContract, 'finalizeInterrupted'>;
