import { join } from 'node:path';

import { discardRecordedArtifacts, managed } from '../capability.js';
import type {
  PreflightRuntime,
  ProviderArtifactHandleInput,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '../contract.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';
import type { AppServerMethod, AppServerRequestParams, AppServerResponse } from './protocol.js';
import {
  buildCodexProviderServerSpec,
  clearCodexTurnContinuity,
  isCodexSessionUnavailable,
  readCodexPersistedContinuity,
} from './request-mapping.js';

const CODEX_APP_SERVER_UPGRADE_MESSAGE =
  'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE = 'Codex CLI is not authenticated. Run "codex login" to create ~/.codex/auth.json.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;
const CODEX_ROLLOUT_SCAN_DEPTH = 4;

type PreflightCacheEntry = {
  available: boolean;
  checkedAt: number;
};

type CodexArtifactLocatorStorage = Pick<StoragePort, 'existsSync' | 'readdirSync'>;
type CodexArtifactLocatorEnv = Pick<Runtime['env'], 'homedir' | 'get'>;

export type ProviderArtifactLocatorResult =
  | { readonly kind: 'match'; readonly artifact: ProviderArtifactHandleInput }
  | { readonly kind: 'no_match'; readonly diagnostic: string }
  | { readonly kind: 'ambiguous'; readonly diagnostic: string; readonly matches: readonly string[] };

export function resolveCodexSessionsRoot(env: CodexArtifactLocatorEnv): string {
  const codexHome = env.get('CODEX_HOME')?.trim();
  return join(codexHome && codexHome.length > 0 ? codexHome : join(env.homedir(), '.codex'), 'sessions');
}

export function locateCodexRolloutArtifact(options: {
  readonly threadId: string;
  readonly sessionsRoot: string;
  readonly storage: CodexArtifactLocatorStorage;
}): ProviderArtifactLocatorResult {
  const matches = collectCodexRolloutMatches(options.storage, options.sessionsRoot, options.threadId);
  if (matches.length === 0) {
    return {
      kind: 'no_match',
      diagnostic: `No rollout JSONL found matching thread ${options.threadId} under ${options.sessionsRoot}.`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      diagnostic: `${matches.length} rollout JSONL files matched thread ${options.threadId} under ${options.sessionsRoot}; cannot choose one.`,
      matches,
    };
  }
  const [handle] = matches;
  return {
    kind: 'match',
    artifact: {
      handle,
    },
  };
}

export function locateCodexRolloutArtifactFromRuntime(
  threadId: string,
  runtime: Pick<ProviderRuntime, 'env' | 'storage'>,
): ProviderArtifactLocatorResult | null {
  if (!runtime.env) {
    return null;
  }
  return locateCodexRolloutArtifact({
    threadId,
    sessionsRoot: resolveCodexSessionsRoot(runtime.env),
    storage: runtime.storage,
  });
}

function collectCodexRolloutMatches(
  storage: CodexArtifactLocatorStorage,
  root: string,
  threadId: string,
): readonly string[] {
  if (!safeExists(storage, root)) {
    return [];
  }

  const matches: string[] = [];
  const visit = (dir: string, depth: number): void => {
    const entries = safeReadDir(storage, dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && isCodexRolloutFile(entry.name, threadId)) {
        matches.push(fullPath);
        continue;
      }
      if (entry.isDirectory() && depth < CODEX_ROLLOUT_SCAN_DEPTH) {
        visit(fullPath, depth + 1);
      }
    }
  };

  visit(root, 0);
  return matches.sort();
}

function isCodexRolloutFile(name: string, threadId: string): boolean {
  return name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`);
}

function safeExists(storage: CodexArtifactLocatorStorage, path: string): boolean {
  try {
    return storage.existsSync(path);
  } catch {
    return false;
  }
}

function safeReadDir(storage: CodexArtifactLocatorStorage, path: string) {
  try {
    return storage.readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export const codexArtifactCapability = managed({
  discardArtifacts: discardRecordedArtifacts,
});

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
  const now = runtime.time.now();
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
  buildRecoveryMeta(request: ProviderRequest) {
    return request.conversationRef ? { threadId: request.conversationRef } : {};
  },
  async probe(lease, continuity) {
    const parsed = readCodexPersistedContinuity(continuity);
    const updatedContinuity = clearCodexTurnContinuity(continuity);
    if (!parsed.threadId || !parsed.cwd) {
      return { resumable: false, updatedContinuity };
    }

    try {
      await rpc(lease, 'thread/resume', {
        threadId: parsed.threadId,
        cwd: parsed.cwd,
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
