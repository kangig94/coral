import { join } from 'node:path';

import type {
  ProviderPreflightRuntime,
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
import { classifyExecOutcome } from '../../infra/port-types.js';
import { windowsCommandName } from '../../infra/windows-shell.js';

const CODEX_APP_SERVER_UPGRADE_MESSAGE =
  'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE =
  'The selected Codex account is not authenticated. Run "codex login" with the same CODEX_HOME and retry.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;
const CODEX_AUTH_TOKEN_KEYS = ['access_token', 'refresh_token', 'id_token'] as const;

/**
 * What a preflight check observed, in three answers rather than two.
 *
 * `refused` is a condition this run actually established — no app-server subcommand, no auth tokens — and its
 * message names a remedy because there is one. `undetermined` is a check that never completed, and it must not
 * borrow the other's message: telling someone to `npm update -g @openai/codex` because a fork lost to `EAGAIN`
 * sends them to fix software that was never broken, and cites a cause nobody observed.
 *
 * Both still refuse the operation. The distinction is what the operator is told, and — because these are
 * cached — what a later preflight repeats for up to `CODEX_PREFLIGHT_CACHE_TTL_MS` without re-checking.
 */
type PreflightVerdict =
  | { kind: 'satisfied' }
  | { kind: 'refused'; message: string }
  | { kind: 'undetermined'; message: string };

type PreflightCacheEntry = {
  verdict: PreflightVerdict;
  checkedAt: number;
};

let codexAppServerAvailabilityCache: PreflightCacheEntry | null = null;
const codexAuthTokensCache = new Map<string, PreflightCacheEntry>();

function throwUnlessSatisfied(verdict: PreflightVerdict): void {
  if (verdict.kind !== 'satisfied') {
    throw new Error(verdict.message);
  }
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

export async function codexPreflight(runtime: ProviderPreflightRuntime<CodexProviderAccess>): Promise<void> {
  await assertCodexAppServerAvailable(runtime);
  await assertCodexAuthTokens(runtime);
}

/**
 * Whether this Codex CLI has an `app-server` subcommand — and whether we got to find out.
 *
 * Only the binary answering settles it. A launch that failed on anything but a standing fact about this
 * machine, and a child killed before it exited, are both non-answers: they leave the installed Codex CLI
 * exactly as unknown as before the probe ran.
 */
async function probeCodexAppServer(runtime: ProviderPreflightRuntime<CodexProviderAccess>): Promise<PreflightVerdict> {
  const result = await runtime.runExact('codex', ['app-server', '--help'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });

  const outcome = classifyExecOutcome(result);
  switch (outcome.kind) {
    case 'no-answer':
      return {
        kind: 'undetermined',
        message: `Codex preflight could not run \`codex app-server --help\` (${outcome.detail}); this says nothing about the installed Codex CLI. Retry the command in a moment.`,
      };
    case 'launch-refused':
      return { kind: 'refused', message: CODEX_APP_SERVER_UPGRADE_MESSAGE };
    case 'answered':
      return outcome.status === 0
        ? { kind: 'satisfied' }
        : { kind: 'refused', message: CODEX_APP_SERVER_UPGRADE_MESSAGE };
  }
}

async function assertCodexAppServerAvailable(runtime: ProviderPreflightRuntime<CodexProviderAccess>): Promise<void> {
  const now = runtime.time.now();
  if (
    codexAppServerAvailabilityCache &&
    now - codexAppServerAvailabilityCache.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS
  ) {
    throwUnlessSatisfied(codexAppServerAvailabilityCache.verdict);
    return;
  }

  // Only an answer is cached. This cache has no tenant key, so a cached verdict decides for every later job,
  // and a job must not be refused on an observation some earlier job failed to make — `throwUnlessSatisfied`
  // rejects, and a rejected preflight terminalizes. Holding the non-answer would have saved a fork per
  // operation on a wedged machine; it would have spent that saving on deciding for jobs that never observed
  // anything, which is the trade §11 forbids.
  //
  // The residual is that an `undetermined` verdict still terminalizes the job that *did* observe it, because
  // `ProviderPreflight` returns `Promise<void>` and any rejection is terminal — there is no way here to say
  // "ask again". That needs a provider-contract change and is `docs/todo/preflight-cannot-defer.md`.
  const verdict = await probeCodexAppServer(runtime);
  if (verdict.kind !== 'undetermined') {
    codexAppServerAvailabilityCache = { verdict, checkedAt: runtime.time.now() };
  }
  throwUnlessSatisfied(verdict);
}

/**
 * Whether the selected Codex home holds usable auth tokens.
 *
 * The one blanket `catch` here covered a file that is not there, a file that is there and is not JSON, and a
 * file this process is not allowed to open — and answered all three with "run `codex login`". The first two
 * are answers, and that remedy is the right one for both: `codex login` writes the file, whether it is absent
 * or corrupt. The third is not an answer at all, and the remedy does not apply to it — a login that cannot
 * read `auth.json` afterwards has fixed nothing.
 *
 * `ENOENT` sits on the decisive side here, which is the reverse of what it means to
 * `STANDING_PROBE_ERRNOS` above. There it describes a binary that could not be launched; here it describes a
 * file that is simply absent, and absence is exactly the thing being asked about. Same errno, different
 * question — do not unify the two lists.
 */
function probeCodexAuthTokens(runtime: ProviderPreflightRuntime<CodexProviderAccess>): PreflightVerdict {
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
        : '';
    return {
      kind: 'undetermined',
      message: `Codex preflight could not read ${authPath} (${code ?? 'unknown error'}); whether this account is authenticated was not established.${remedy}`,
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

async function assertCodexAuthTokens(runtime: ProviderPreflightRuntime<CodexProviderAccess>): Promise<void> {
  const now = runtime.time.now();
  const cacheKey = runtime.access.home;
  const cached = codexAuthTokensCache.get(cacheKey);
  if (cached && now - cached.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    throwUnlessSatisfied(cached.verdict);
    return;
  }

  const verdict = probeCodexAuthTokens(runtime);
  // Same rule as above: an unreadable `auth.json` is not an answer about this account, and must not stand in
  // as one for the next job. This cache is keyed by home, so the blast radius is narrower, not absent.
  if (verdict.kind !== 'undetermined') {
    codexAuthTokensCache.set(cacheKey, { verdict, checkedAt: now });
  }
  throwUnlessSatisfied(verdict);
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
