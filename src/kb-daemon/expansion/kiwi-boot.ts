import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { hasKiwiModelArtifact, ensureKiwiModelArtifact } from '../../engines/kiwi/model-artifact.js';
import { ORAMA_BASE_CONSUMER_ID } from '../../engines/orama/constants.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../kb/contract.js';
import type { Runtime } from '../../runtime/ports.js';
import type { GeneratedCommunityFreshness } from '../../kb/curate/community/generated-projection-store.js';

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
  readonly hasModelArtifact?: (runtime: Runtime) => boolean;
  readonly ensureModelArtifact?: typeof ensureKiwiModelArtifact;
  readonly onModelFetchStart?: () => void;
  readonly onModelFetchEnd?: () => void;
};

async function forceOramaReindexAfterKiwiFetch(
  kb: Pick<KbRuntime, 'invalidateTextSnapshot' | 'generatedCommunityProjectionStore'>,
  driver: KiwiArtifactBootDriver,
  snapshot: KbCorpusSnapshot,
  timeoutMs: number,
): Promise<void> {
  kb.invalidateTextSnapshot('kiwi-model-installed');
  const generatedCommunityFreshness = kb.generatedCommunityProjectionStore.readActiveFreshness();
  const forced = driver.forceCorpusApply(snapshot, {
    reason: 'projection-artifact-lag',
    consumers: [ORAMA_BASE_CONSUMER_ID],
    generatedCommunityFreshness,
  });
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

export function startKiwiArtifactFetchOnBoot({
  runtime,
  kb,
  driver,
  timeoutMs,
  signal,
  hasModelArtifact = hasKiwiModelArtifact,
  ensureModelArtifact = ensureKiwiModelArtifact,
  onModelFetchStart,
  onModelFetchEnd,
}: StartKiwiArtifactFetchOnBootOptions): KiwiArtifactBootHandle {
  if (!kb.declaredAnalyzers?.includes('ko')) {
    return { started: false, completed: null };
  }

  const completed = (async () => {
    if (hasModelArtifact(runtime)) {
      return;
    }
    const snapshot = kb.getCorpusStateSnapshot();
    onModelFetchStart?.();
    let result: Awaited<ReturnType<typeof ensureKiwiModelArtifact>>;
    try {
      result = await ensureModelArtifact(runtime, {
        logger: (event) => backendLog.raw(`[kiwi] ${event.message}`),
      });
    } finally {
      onModelFetchEnd?.();
    }
    if (result.status === 'error') {
      backendLog.warn(`[kiwi] model fetch failed: ${result.userMessage}`);
      return;
    }
    if (signal.aborted) {
      return;
    }
    await forceOramaReindexAfterKiwiFetch(kb, driver, snapshot, timeoutMs);
  })().catch((error: unknown) => {
    backendLog.warn(`[kiwi] background model fetch failed: ${errorMessage(error)}`);
  });

  return { started: true, completed };
}
