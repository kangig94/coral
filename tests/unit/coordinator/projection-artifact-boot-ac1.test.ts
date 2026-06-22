import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import {
  FreshnessTimeout,
  type ConsumerDriver,
  type ForcedCorpusFreshnessTarget,
} from '#src/coordinator/consumer-driver/index.js';
import { repairProjectionArtifactLagOnBoot } from '#src/coordinator/index.js';
import { ORAMA_BASE_CONSUMER_ID } from '#src/engines/orama/backend.js';
import type { EngineArtifactDescriptor } from '#src/kb/corpus/artifact-port.js';
import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';

const SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: 'snapshot-ac1',
  contentSeq: 1,
  metadataSeq: 1,
  contentManifestHash: 'content-ac1',
  metadataManifestHash: 'metadata-ac1',
};

afterEach(() => {
  vi.restoreAllMocks();
});

function descriptorFor(targetConsumerIds: readonly string[]): EngineArtifactDescriptor {
  return {
    artifactId: 'orama:projection-cache',
    kind: 'projection-cache',
    targetConsumerIds,
    corpusInterest: 'both',
    artifactPaths: [],
    expectedProjectionIdentityHash: 'new-identity',
    freshness: {
      status: 'present',
      projected: {
        ...SNAPSHOT,
        projectionIdentityHash: 'old-identity',
      },
    },
  };
}

function kbWithDescriptor(descriptor: EngineArtifactDescriptor): KbRuntime {
  return {
    getCorpusStateSnapshot: () => SNAPSHOT,
    engineArtifactRegistry: {
      describeArtifacts: async () => [descriptor],
    },
  } as unknown as KbRuntime;
}

function driverThatTimesOut(consumerIds: readonly string[]): ConsumerDriver {
  return {
    forceCorpusApply: vi.fn(() => ({ generation: 11, consumers: consumerIds })),
    waitFreshUntil: vi.fn(async (_authority, target, consumerId, timeoutMs) => {
      throw new FreshnessTimeout(consumerId, target as ForcedCorpusFreshnessTarget, timeoutMs ?? 0);
    }),
  } as unknown as ConsumerDriver;
}

describe('repairProjectionArtifactLagOnBoot AC1 fallback', () => {
  it('keeps boot availability for an Orama-only FreshnessTimeout and leaves the forced apply started', async () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const driver = driverThatTimesOut([ORAMA_BASE_CONSUMER_ID]);

    const result = await repairProjectionArtifactLagOnBoot(
      kbWithDescriptor(descriptorFor([ORAMA_BASE_CONSUMER_ID])),
      driver,
      25,
    );

    expect(result).toEqual({ allowStaleFts: true });
    expect(driver.forceCorpusApply).toHaveBeenCalledWith(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: [ORAMA_BASE_CONSUMER_ID],
    });
    expect(driver.waitFreshUntil).toHaveBeenCalledWith(
      'corpus',
      { snapshot: SNAPSHOT, atLeastGeneration: 11 },
      ORAMA_BASE_CONSUMER_ID,
      25,
    );
  });

  it('does not swallow non-Orama FreshnessTimeout failures', async () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const driver = driverThatTimesOut(['vector-base']);

    await expect(
      repairProjectionArtifactLagOnBoot(kbWithDescriptor(descriptorFor(['vector-base'])), driver, 25),
    ).rejects.toBeInstanceOf(FreshnessTimeout);
  });

  it('does not swallow mixed Orama and non-Orama FreshnessTimeout failures', async () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const targets = [ORAMA_BASE_CONSUMER_ID, 'vector-base'];
    const driver = driverThatTimesOut(targets);

    await expect(
      repairProjectionArtifactLagOnBoot(kbWithDescriptor(descriptorFor(targets)), driver, 25),
    ).rejects.toBeInstanceOf(FreshnessTimeout);
  });
});
