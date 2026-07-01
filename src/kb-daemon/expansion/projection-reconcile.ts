import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { ORAMA_BASE_CONSUMER_ID, type OramaReconcileReason } from '../../engines/orama/constants.js';
import { detectProjectionArtifactLag } from '../../kb/corpus/rescan/drift.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../kb/contract.js';
import type { KiwiAnalyzerDegradedEvent } from '../../engines/kiwi/analyzer-manager.js';
import type { GeneratedCommunityFreshness } from '../../kb/curate/community/generated-projection-store.js';

type OramaProjectionReconcileResult = {
  readonly generation: number;
  readonly consumers: readonly string[];
};

type OramaProjectionReconcileDriver = {
  forceCorpusApply(
    snapshot: KbCorpusSnapshot,
    options: {
      readonly reason: 'projection-artifact-lag';
      readonly consumers: readonly string[];
      readonly generatedCommunityFreshness?: GeneratedCommunityFreshness;
    },
  ): OramaProjectionReconcileResult | PromiseLike<OramaProjectionReconcileResult>;
};

export type OramaProjectionReconcileRuntime = Pick<
  KbRuntime,
  'getCorpusStateSnapshot' | 'invalidateTextSnapshot' | 'generatedCommunityProjectionStore'
>;
export type ProjectionArtifactBootRuntime = Pick<
  KbRuntime,
  'engineArtifactRegistry' | 'getCorpusStateSnapshot' | 'generatedCommunityProjectionStore'
>;

type BootProjectionArtifactRepairResult = {
  readonly allowStaleFts: boolean;
};

/**
 * True when the only projection-artifact-lag repair target is the Orama base
 * (FTS) consumer. This file is a documented engine-import wiring point so the
 * coordinator boot path does not import `ORAMA_BASE_CONSUMER_ID` directly from
 * `src/engines/**`.
 */
export function isOramaOnlyRepairTarget(consumerIds: readonly string[]): boolean {
  return consumerIds.length === 1 && consumerIds[0] === ORAMA_BASE_CONSUMER_ID;
}

export async function repairProjectionArtifactLagOnBoot(
  kb: ProjectionArtifactBootRuntime,
  driver: OramaProjectionReconcileDriver,
  timeoutMs: number,
): Promise<BootProjectionArtifactRepairResult> {
  const lag = detectProjectionArtifactLag(kb, await kb.engineArtifactRegistry.describeArtifacts());
  const targetConsumerIds: string[] = [];
  const seenTargetConsumers = new Set<string>();
  for (const entry of lag) {
    for (const consumerId of entry.targetConsumerIds) {
      if (seenTargetConsumers.has(consumerId)) {
        continue;
      }
      seenTargetConsumers.add(consumerId);
      targetConsumerIds.push(consumerId);
    }
  }
  if (targetConsumerIds.length === 0) {
    return { allowStaleFts: false };
  }

  const snapshot = kb.getCorpusStateSnapshot();
  const forced = await driver.forceCorpusApply(snapshot, {
    reason: 'projection-artifact-lag',
    consumers: targetConsumerIds,
    generatedCommunityFreshness: kb.generatedCommunityProjectionStore.readActiveFreshness(),
  });
  void timeoutMs;
  if (forced.consumers.length > 0) {
    backendLog.warn(
      `[kb] Projection artifact repair scheduled during boot for ${forced.consumers.join(', ')}; ` +
        'KB will serve stale or degraded retrieval until background reconcile catches up.',
    );
  }
  return { allowStaleFts: isOramaOnlyRepairTarget(targetConsumerIds) };
}

export type OramaProjectionReconcileRequester = {
  readonly requestProjectionReconcile: (reason: OramaReconcileReason) => void;
  readonly requestKiwiDegradedReconcile: (event: KiwiAnalyzerDegradedEvent) => void;
  readonly waitForIdle: () => Promise<void>;
};

export function createOramaProjectionReconcileRequester(params: {
  readonly kb: OramaProjectionReconcileRuntime;
  readonly driver: OramaProjectionReconcileDriver;
  readonly log?: (message: string) => void;
}): OramaProjectionReconcileRequester {
  let inFlight: Promise<void> | null = null;
  const log = params.log ?? ((message) => backendLog.warn(message));

  const request = (reason: OramaReconcileReason | 'kiwi-degraded'): void => {
    if (inFlight !== null) {
      return;
    }

    inFlight = Promise.resolve()
      .then(async () => {
        if (reason === 'kiwi-degraded') {
          params.kb.invalidateTextSnapshot('kiwi-degraded');
        }
        const snapshot = params.kb.getCorpusStateSnapshot();
        await params.driver.forceCorpusApply(snapshot, {
          reason: 'projection-artifact-lag',
          consumers: [ORAMA_BASE_CONSUMER_ID],
          generatedCommunityFreshness: params.kb.generatedCommunityProjectionStore.readActiveFreshness(),
        });
      })
      .catch((error: unknown) => {
        log(`[orama] projection reconcile request failed (${reason}): ${errorMessage(error)}`);
      })
      .finally(() => {
        inFlight = null;
      });
  };

  return {
    requestProjectionReconcile: request,
    requestKiwiDegradedReconcile: () => request('kiwi-degraded'),
    waitForIdle: async () => {
      await inFlight;
    },
  };
}
