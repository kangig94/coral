import { afterEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import { type ConsumerDriver } from '#src/coordinator/consumer-driver/index.js';
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

function driverForRepair(consumerIds: readonly string[]): ConsumerDriver {
  return {
    forceCorpusApply: vi.fn(() => ({ generation: 11, consumers: consumerIds })),
    waitFreshUntil: vi.fn(),
  } as unknown as ConsumerDriver;
}

describe('repairProjectionArtifactLagOnBoot AC1 fallback', () => {
  it('keeps boot availability for an Orama-only projection lag and leaves the forced apply running', async () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const driver = driverForRepair([ORAMA_BASE_CONSUMER_ID]);

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
    expect(driver.waitFreshUntil).not.toHaveBeenCalled();
  });

  it('does not wait for non-Orama projection repair during boot', async () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const driver = driverForRepair(['vector-base']);

    await expect(
      repairProjectionArtifactLagOnBoot(kbWithDescriptor(descriptorFor(['vector-base'])), driver, 25),
    ).resolves.toEqual({ allowStaleFts: false });
    expect(driver.forceCorpusApply).toHaveBeenCalledWith(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: ['vector-base'],
    });
    expect(driver.waitFreshUntil).not.toHaveBeenCalled();
  });

  it('does not wait for mixed projection repair during boot', async () => {
    vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const targets = [ORAMA_BASE_CONSUMER_ID, 'vector-base'];
    const driver = driverForRepair(targets);

    await expect(
      repairProjectionArtifactLagOnBoot(kbWithDescriptor(descriptorFor(targets)), driver, 25),
    ).resolves.toEqual({ allowStaleFts: false });
    expect(driver.waitFreshUntil).not.toHaveBeenCalled();
  });
});
