import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  handoffRoutingStatusStoreSchema,
  publishGenerationCoordinatedHandoffRoutingTransitions,
  type HandoffRoutingTransition,
} from '#src/coordinator/handoff-routing/status.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { acquireGenerationMaintenanceLease } from '#src/store/generation-mutation-coordination.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
const temporaryDirectories: string[] = [];

function owner(pid = process.pid): Readonly<{ pid: number; incarnation: ReturnType<typeof testIncarnation> }> {
  return { pid, incarnation: testIncarnation(pid) };
}

function observedAt(offset: number): string {
  return new Date(Date.parse('2026-03-01T00:00:00.000Z') + offset).toISOString();
}

function selection(identity: string, offset: number): HandoffRoutingTransition {
  return {
    kind: 'routing-selected',
    eventId: `selection-${identity}`,
    invocationId: `invocation-${identity}`,
    observedAt: observedAt(offset),
    owner: owner(),
    disposition: {
      kind: 'continue-current',
      basis: { kind: 'same-build-set', buildSetId: '123e4567-e89b-42d3-a456-426614174000' },
    },
  };
}

afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('handoff-routing/status', () => {
  it('refuses publication while generation maintenance is held', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-maintenance-'));
    temporaryDirectories.push(baseDir);
    const isolatedRuntime = createRealRuntime('prod', { baseDir });
    const path = join(
      isolatedRuntime.paths.coral.coordinator.runDir,
      `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`,
    );
    const maintenance = await acquireGenerationMaintenanceLease(isolatedRuntime);
    try {
      await expect(
        publishGenerationCoordinatedHandoffRoutingTransitions(isolatedRuntime, path, [
          selection('after-maintenance', 1),
        ]),
      ).resolves.toEqual({
        kind: 'not-published',
        cause: 'generation-maintenance',
      });
      expect(existsSync(path)).toBe(false);
    } finally {
      maintenance.release();
    }

    await expect(
      publishGenerationCoordinatedHandoffRoutingTransitions(isolatedRuntime, path, [selection('after-maintenance', 1)]),
    ).resolves.toMatchObject({ kind: 'committed' });
  });
});
