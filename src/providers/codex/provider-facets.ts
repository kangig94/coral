import { join } from 'node:path';

import type {
  ProviderPreflightRuntime,
  ProviderPreflightOutcome,
  ProviderAppServerCapability,
  AppServerTransport,
  ProviderInterruptRequestOutcome,
  ProviderRecoveryContract,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { SessionContinuityMutation } from '../../sessions/continuity-mutation.js';
import {
  turnInterruptResponseSchema,
  type AppServerMethod,
  type AppServerRequestParams,
  type AppServerResponse,
} from './protocol.js';
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
import { isNoEntryError } from '../../infra/fs-errors.js';
import { assertNever } from '../../infra/error-format.js';
import { classifyExecOutcome, classifySpawnFailure, type SpawnFailureEvidence } from '../../infra/port-types.js';
import { windowsCommandName } from '../../infra/windows-shell.js';

const CODEX_APP_SERVER_UPGRADE_MESSAGE =
  'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE =
  'The selected Codex account is not authenticated. Run "codex login" with the same CODEX_HOME and retry.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;
const CODEX_AUTH_TOKEN_KEYS = ['access_token', 'refresh_token', 'id_token'] as const;

type PreflightCacheEntry = {
  outcome: ProviderPreflightOutcome;
  checkedAt: number;
};

type CodexAppServerProbeResult =
  | Readonly<{
      answered: true;
      outcome: Extract<ProviderPreflightOutcome, { kind: 'satisfied' | 'refused' }>;
    }>
  | Readonly<{
      answered: false;
      outcome: Extract<ProviderPreflightOutcome, { kind: 'refused' | 'undetermined' }>;
    }>;

let codexAppServerAvailabilityCache: PreflightCacheEntry | null = null;
const codexAuthTokensCache = new Map<string, PreflightCacheEntry>();

/** A test isolates itself from a sibling's cached verdict today by
 *  advancing a shared fake clock past `CODEX_PREFLIGHT_CACHE_TTL_MS` in `beforeEach` — this is the explicit
 *  escape hatch `createCliDetector`'s `resetCache` offers its own instance-scoped cache, for the one case that
 *  clock gap does not reach: a test that does not preserve it. */
export function resetCodexPreflightCachesForTest(): void {
  codexAppServerAvailabilityCache = null;
  codexAuthTokensCache.clear();
}

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

export async function codexPreflight(
  runtime: ProviderPreflightRuntime<CodexProviderAccess>,
): Promise<ProviderPreflightOutcome> {
  const availability = await checkCodexAppServerAvailability(runtime);
  if (availability.kind !== 'satisfied') return availability;
  return checkCodexAuthTokens(runtime);
}

function codexOutcomeFromSpawnFailure(
  runtime: ProviderPreflightRuntime<CodexProviderAccess>,
  evidence: SpawnFailureEvidence,
): Extract<ProviderPreflightOutcome, { kind: 'refused' | 'undetermined' }> {
  switch (evidence.kind) {
    case 'command-could-not-start':
      return {
        kind: 'refused',
        message:
          "Coral could not start `codex` using the Coral daemon's PATH (ENOENT); ensure `codex` is installed and runnable at a location on that PATH, and restart the Coral backend after changing that PATH before retrying.",
      };
    case 'command-not-executable':
      return evidence.code === 'ENOTDIR'
        ? {
            kind: 'refused',
            message:
              "Coral could not execute `codex` because the Coral daemon's PATH resolves it through a component that is not a directory (ENOTDIR). Correct that PATH, restart the Coral backend, then retry.",
          }
        : {
            kind: 'refused',
            message: `Coral could not execute the \`codex\` command selected by the Coral daemon's PATH (${evidence.code}). Fix that executable's permissions and retry, or correct the daemon's PATH and restart the Coral backend first.`,
          };
    case 'working-directory-missing':
      return {
        kind: 'refused',
        message: `Coral could not start Codex because working directory \`${runtime.cwd}\` does not exist. Restore it or choose another working directory, then retry.`,
      };
    case 'working-directory-not-directory':
      return {
        kind: 'refused',
        message: `Coral could not start Codex because working directory \`${runtime.cwd}\` is not a directory. Choose a directory, then retry.`,
      };
    case 'working-directory-not-traversable':
      return {
        kind: 'refused',
        message: `Coral could not start Codex because working directory \`${runtime.cwd}\` is not traversable by the user running the Coral daemon. Grant that user search permission or choose another working directory, then retry.`,
      };
    case 'unresolved':
      return {
        kind: 'undetermined',
        message: `Coral could not determine whether \`codex\` or working directory \`${runtime.cwd}\` prevented the app-server check from starting (${evidence.code}). Verify that the directory exists and is traversable by the user running the Coral daemon, then retry.`,
      };
    default:
      return assertNever(evidence);
  }
}

async function probeCodexAppServer(
  runtime: ProviderPreflightRuntime<CodexProviderAccess>,
): Promise<CodexAppServerProbeResult> {
  const result = await runtime.runExact('codex', ['app-server', '--help'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });

  const outcome = classifyExecOutcome(result);
  switch (outcome.kind) {
    case 'no-answer':
      return {
        answered: false,
        outcome: {
          kind: 'undetermined',
          message: `Coral could not complete the Codex app-server check because \`codex app-server --help\` did not answer (${outcome.detail}). Retry the request; if this keeps happening, verify that the Codex CLI starts promptly for the user running the Coral daemon.`,
        },
      };
    case 'launch-refused':
      return {
        answered: false,
        outcome: codexOutcomeFromSpawnFailure(
          runtime,
          classifySpawnFailure(runtime.storage, runtime.cwd, outcome.code),
        ),
      };
    case 'answered':
      return {
        answered: true,
        outcome:
          outcome.status === 0 ? { kind: 'satisfied' } : { kind: 'refused', message: CODEX_APP_SERVER_UPGRADE_MESSAGE },
      };
  }
}

async function checkCodexAppServerAvailability(
  runtime: ProviderPreflightRuntime<CodexProviderAccess>,
): Promise<ProviderPreflightOutcome> {
  const now = runtime.time.now();
  if (
    codexAppServerAvailabilityCache &&
    now - codexAppServerAvailabilityCache.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS
  ) {
    return codexAppServerAvailabilityCache.outcome;
  }

  const probe = await probeCodexAppServer(runtime);
  // Launch attribution reconstructed after failure must not outlive the request that observed it.
  if (probe.answered) {
    codexAppServerAvailabilityCache = { outcome: probe.outcome, checkedAt: runtime.time.now() };
  }
  return probe.outcome;
}

/**
 * Whether the selected Codex home holds usable auth tokens.
 *
 * `ENOENT` from this absolute file read establishes that no auth document exists at the selected path, so a
 * login that writes the file is a valid remedy — as it is for a file that is there and is not JSON.
 * `EACCES`/`EPERM` must remain `undetermined`: the file might hold valid tokens this process cannot
 * observe, and a login does not grant the daemon permission to read it.
 */
function probeCodexAuthTokens(runtime: ProviderPreflightRuntime<CodexProviderAccess>): ProviderPreflightOutcome {
  const authPath = join(runtime.access.home, 'auth.json');

  let raw: string;
  try {
    raw = runtime.storage.readFileSync(authPath, 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return { kind: 'refused', message: CODEX_AUTH_ERROR_MESSAGE };
    }
    const code = (error as NodeJS.ErrnoException).code;
    // `EACCES`/`EPERM` is the one non-answer here with a remedy that is knowable from the errno alone, so it
    // gets one. The others get no invented advice.
    const remedy =
      code === 'EACCES' || code === 'EPERM'
        ? ' Check that this file is readable by the user running the Coral daemon.'
        : ' Retry the command; this says nothing about whether the account is authenticated.';
    return {
      kind: 'undetermined',
      message: `Coral could not read the Codex authentication file at ${authPath} (${code ?? 'unknown error'}); whether this account is authenticated was not established.${remedy}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: 'refused', message: CODEX_AUTH_ERROR_MESSAGE };
  }

  return hasCodexAuthTokens(parsed) ? { kind: 'satisfied' } : { kind: 'refused', message: CODEX_AUTH_ERROR_MESSAGE };
}

function checkCodexAuthTokens(runtime: ProviderPreflightRuntime<CodexProviderAccess>): ProviderPreflightOutcome {
  const now = runtime.time.now();
  const cacheKey = runtime.access.home;
  const cached = codexAuthTokensCache.get(cacheKey);
  if (cached && now - cached.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    return cached.outcome;
  }

  const outcome = probeCodexAuthTokens(runtime);
  // Same rule as above: an unreadable `auth.json` is not an answer about this account, and must not stand in
  // as one for the next job. This cache is keyed by home, so the blast radius is narrower, not absent.
  if (outcome.kind !== 'undetermined') {
    codexAuthTokensCache.set(cacheKey, { outcome, checkedAt: now });
  }
  return outcome;
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
    idleRetirement: 'unleased',
    initializeRequest: {
      method: 'initialize',
      params: { clientInfo: { name: 'coral', version: 'unknown' } },
    },
  }),
  async interrupt(
    lease: AppServerTransport,
    continuity: ProviderContinuityBlob,
  ): Promise<ProviderInterruptRequestOutcome> {
    const parsed = readCodexPersistedContinuity(continuity);
    if (parsed.threadId === undefined || parsed.turnId === undefined) {
      return { kind: 'not-accepted', reason: 'Codex continuity is missing the active thread or turn id.' };
    }
    const result = await rpc(lease, 'turn/interrupt', { threadId: parsed.threadId, turnId: parsed.turnId });
    turnInterruptResponseSchema.parse(result);
    return { kind: 'accepted' };
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
