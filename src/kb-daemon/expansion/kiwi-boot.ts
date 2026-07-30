import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { ensureKiwiArtifact, hasKiwiArtifact } from '../../engines/kiwi/artifact.js';
import { ORAMA_BASE_CONSUMER_ID } from '../../engines/orama/constants.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../kb/contract.js';
import type { Runtime } from '../../runtime/ports.js';
import type { GeneratedCommunityFreshness } from '../../kb/curate/community/generated-projection-store.js';

const KIWI_BOOT_LOCK_PROBE_TIMEOUT_MS = 250;
const KIWI_BOOT_LOCK_RETRY_INITIAL_DELAY_MS = 250;
const KIWI_BOOT_LOCK_RETRY_MAX_DELAY_MS = 5_000;

export type KiwiArtifactBootHandle = {
  readonly started: boolean;
  readonly completed: Promise<void> | null;
};

type KiwiArtifactBootDriver = {
  forceCorpusApply(
    snapshot: KbCorpusSnapshot,
    options: {
      readonly reason: 'projection-artifact-lag';
      readonly consumers: readonly string[];
      readonly generatedCommunityFreshness?: GeneratedCommunityFreshness;
    },
  ): { readonly generation: number; readonly consumers: readonly string[] };
  waitFreshUntil(
    authority: 'corpus',
    target: {
      readonly snapshot: KbCorpusSnapshot;
      readonly atLeastGeneration: number;
      readonly generatedCommunityGeneration?: number;
      readonly generatedCommunityDocsHash?: string;
    },
    consumerId: string,
    timeoutMs: number,
  ): Promise<void>;
};

export type StartKiwiArtifactFetchOnBootOptions = {
  readonly runtime: Runtime;
  readonly kb: Pick<
    KbRuntime,
    'getCorpusStateSnapshot' | 'invalidateTextSnapshot' | 'generatedCommunityProjectionStore'
  > &
    Partial<Pick<KbRuntime, 'declaredAnalyzers'>>;
  readonly driver: KiwiArtifactBootDriver;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly hasArtifact?: (runtime: Runtime) => boolean;
  readonly ensureArtifact?: typeof ensureKiwiArtifact;
  readonly onArtifactFetchStart?: () => void;
  readonly onArtifactFetchEnd?: () => void;
  readonly lockProbeTimeoutMs?: number;
  readonly lockRetryDelayMs?: number;
  readonly lockRetryMaxDelayMs?: number;
};

async function forceOramaReindexAfterKiwiFetch(
  kb: Pick<KbRuntime, 'invalidateTextSnapshot' | 'generatedCommunityProjectionStore'>,
  driver: KiwiArtifactBootDriver,
  snapshot: KbCorpusSnapshot,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  kb.invalidateTextSnapshot('kiwi-artifact-installed');
  if (signal.aborted) {
    return;
  }
  const generatedCommunityFreshness = kb.generatedCommunityProjectionStore.readActiveFreshness();
  const forced = driver.forceCorpusApply(snapshot, {
    reason: 'projection-artifact-lag',
    consumers: [ORAMA_BASE_CONSUMER_ID],
    generatedCommunityFreshness,
  });
  if (signal.aborted) {
    return;
  }
  await Promise.all(
    forced.consumers.map((consumerId) =>
      driver.waitFreshUntil(
        'corpus',
        { snapshot, atLeastGeneration: forced.generation, ...generatedCommunityFreshness },
        consumerId,
        timeoutMs,
      ),
    ),
  );
}

type ArtifactEnsureAttempt =
  | { readonly kind: 'ready' }
  | { readonly kind: 'contended' }
  | { readonly kind: 'incomplete'; readonly status: string }
  | {
      readonly kind: 'failed';
      readonly userMessage: string;
      readonly remediation: string;
    };

async function attemptArtifactEnsure(params: {
  readonly runtime: Runtime;
  readonly hasArtifact: (runtime: Runtime) => boolean;
  readonly ensureArtifact: typeof ensureKiwiArtifact;
  readonly lockProbeTimeoutMs: number;
}): Promise<ArtifactEnsureAttempt> {
  if (params.hasArtifact(params.runtime)) {
    return { kind: 'ready' };
  }
  const result = await params.ensureArtifact(params.runtime, {
    logger: (event) => backendLog.raw(`[kiwi] ${event.message}`),
    lockTimeoutMs: params.lockProbeTimeoutMs,
  });
  if (result.status !== 'error') {
    return params.hasArtifact(params.runtime) ? { kind: 'ready' } : { kind: 'incomplete', status: result.status };
  }
  if (result.code !== 'expansion_install_lock_contended') {
    return {
      kind: 'failed',
      userMessage: result.userMessage,
      remediation: result.remediation,
    };
  }
  return params.hasArtifact(params.runtime) ? { kind: 'ready' } : { kind: 'contended' };
}

function resolveTerminalArtifactAttempt(attempt: ArtifactEnsureAttempt): boolean | null {
  if (attempt.kind === 'ready') {
    return true;
  }
  if (attempt.kind === 'incomplete') {
    backendLog.warn(
      `[kiwi] artifact install returned ${attempt.status}, but composite readiness is still incomplete. ` +
        'Intl fallback remains active; run `coral-cli expansion equip kiwi` to repair the artifacts.',
    );
    return false;
  }
  if (attempt.kind === 'failed') {
    backendLog.warn(
      `[kiwi] artifact fetch failed: ${attempt.userMessage} ${attempt.remediation} ` + 'Intl fallback remains active.',
    );
    return false;
  }
  return null;
}

async function ensureArtifactWithContentionRetry(params: {
  readonly runtime: Runtime;
  readonly signal: AbortSignal;
  readonly hasArtifact: (runtime: Runtime) => boolean;
  readonly ensureArtifact: typeof ensureKiwiArtifact;
  readonly lockProbeTimeoutMs: number;
  readonly initialRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
}): Promise<boolean> {
  let retryDelayMs = Math.max(1, params.initialRetryDelayMs);
  const maxRetryDelayMs = Math.max(retryDelayMs, params.maxRetryDelayMs);
  let contentionLogged = false;
  while (!params.signal.aborted) {
    const attempt = await attemptArtifactEnsure({
      runtime: params.runtime,
      hasArtifact: params.hasArtifact,
      ensureArtifact: params.ensureArtifact,
      lockProbeTimeoutMs: params.lockProbeTimeoutMs,
    });
    const terminal = resolveTerminalArtifactAttempt(attempt);
    if (terminal !== null) {
      return terminal;
    }
    if (!contentionLogged) {
      contentionLogged = true;
      backendLog.raw(
        '[kiwi] another package operation holds the install lock; background recovery will keep retrying ' +
          'until it completes or the daemon shuts down.',
      );
    }
    try {
      await params.runtime.time.sleep(retryDelayMs, { signal: params.signal });
    } catch (error: unknown) {
      if (params.signal.aborted) {
        return false;
      }
      throw error;
    }
    retryDelayMs = Math.min(maxRetryDelayMs, retryDelayMs * 2);
  }
  return false;
}

export function startKiwiArtifactFetchOnBoot({
  runtime,
  kb,
  driver,
  timeoutMs,
  signal,
  hasArtifact = hasKiwiArtifact,
  ensureArtifact = ensureKiwiArtifact,
  onArtifactFetchStart,
  onArtifactFetchEnd,
  lockProbeTimeoutMs = KIWI_BOOT_LOCK_PROBE_TIMEOUT_MS,
  lockRetryDelayMs = KIWI_BOOT_LOCK_RETRY_INITIAL_DELAY_MS,
  lockRetryMaxDelayMs = KIWI_BOOT_LOCK_RETRY_MAX_DELAY_MS,
}: StartKiwiArtifactFetchOnBootOptions): KiwiArtifactBootHandle {
  if (!kb.declaredAnalyzers?.includes('ko') || signal.aborted || hasArtifact(runtime)) {
    return { started: false, completed: null };
  }

  const completed = (async () => {
    onArtifactFetchStart?.();
    let ready: boolean;
    try {
      ready = await ensureArtifactWithContentionRetry({
        runtime,
        signal,
        hasArtifact,
        ensureArtifact,
        lockProbeTimeoutMs: Math.max(1, lockProbeTimeoutMs),
        initialRetryDelayMs: lockRetryDelayMs,
        maxRetryDelayMs: lockRetryMaxDelayMs,
      });
    } finally {
      onArtifactFetchEnd?.();
    }
    if (!ready || signal.aborted) {
      return;
    }
    const snapshot = kb.getCorpusStateSnapshot();
    await forceOramaReindexAfterKiwiFetch(kb, driver, snapshot, timeoutMs, signal);
    if (!signal.aborted) {
      backendLog.raw('[kiwi] runtime artifacts are ready; Korean search reindex completed without a restart.');
    }
  })().catch((error: unknown) => {
    if (!signal.aborted) {
      backendLog.warn(
        `[kiwi] background artifact recovery failed: ${errorMessage(error)}. Intl fallback remains active. ` +
          'Run `coral-cli expansion equip kiwi` to retry.',
      );
    }
  });

  return { started: true, completed };
}
