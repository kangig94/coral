import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MAX_COMPLETED_HANDOFF_ROUTING_PAIRS,
  MAX_LEGAL_COMPACTABLE_CONTINUATION_FINALIZED_TRANSITION,
  MAX_LEGAL_ROUTING_SELECTED_TRANSITION,
  handoffRoutingStatusStoreSchema,
  publishGenerationCoordinatedHandoffRoutingTransitions,
  type HandoffRoutingTransition,
} from '#src/coordinator/handoff-routing/status.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { acquireGenerationMaintenanceLease } from '#src/store/generation-mutation-coordination.js';
import { handoffRoutingStatusGeneration } from '#src/store/handoff-routing-status-store/index.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
const BYTE_PRESSURE_COMPLETED_PAIRS = 204;
// Keep this pressure batch below the packing-sensitive capacity boundary.
const BYTE_PRESSURE_BATCHED_PAIRS = 96;
const HANDOFF_ROUTING_STATUS_GENERATION = handoffRoutingStatusGeneration(handoffRoutingStatusStoreSchema());
const temporaryDirectories: string[] = [];
const runtimeBaseDir = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-runtime-'));
temporaryDirectories.push(runtimeBaseDir);
const runtime = createRealRuntime('prod', { baseDir: runtimeBaseDir });

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coral-handoff-routing-integration-'));
  temporaryDirectories.push(directory);
  return join(directory, `handoff-routing.${HANDOFF_ROUTING_STATUS_GENERATION}.db`);
}

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

function maximumIdentifier(identity: string): string {
  const encodedIdentity = [...identity]
    .map((character) => String.fromCharCode(0x0800 + character.charCodeAt(0)))
    .join('');
  return `${encodedIdentity}${'\u0800'.repeat(58)}`.slice(0, 58);
}

function maximumSelection(identity: string): HandoffRoutingTransition {
  return {
    ...MAX_LEGAL_ROUTING_SELECTED_TRANSITION,
    eventId: maximumIdentifier(`s${identity}`),
    invocationId: maximumIdentifier(`i${identity}`),
  };
}

function maximumCompactableTerminal(identity: string, selectionSequence: number): HandoffRoutingTransition {
  return {
    ...MAX_LEGAL_COMPACTABLE_CONTINUATION_FINALIZED_TRANSITION,
    eventId: maximumIdentifier(`t${identity}`),
    invocationId: maximumIdentifier(`i${identity}`),
    selection: { kind: 'with-selection-sequence', selectionSequence },
  };
}

async function committed(path: string, transition: HandoffRoutingTransition): Promise<number> {
  const outcome = await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [transition]);
  expect(outcome.kind).toBe('committed');
  if (outcome.kind !== 'committed') throw new Error(`Expected commit, received ${outcome.kind}`);
  return outcome.sequence;
}

function retainedCompletedPairCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare("SELECT COUNT(*) AS count FROM handoff_routing_records WHERE record_kind = 'terminal'").get() as {
        count: number;
      }
    ).count;
  } finally {
    db.close();
  }
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

  it('reserves byte capacity for selection admission and retained-opening closure', async () => {
    const path = databasePath();
    const opening = maximumSelection('opening');
    await committed(path, opening);
    const fill = Array.from({ length: BYTE_PRESSURE_BATCHED_PAIRS }, (_, index) => {
      const identity = `pair-${index}`;
      return [maximumSelection(identity), maximumCompactableTerminal(identity, 2 + index * 2)];
    }).flat();
    await expect(publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, fill)).resolves.toMatchObject({
      kind: 'committed',
    });
    let completedPairs = BYTE_PRESSURE_BATCHED_PAIRS;
    while (retainedCompletedPairCount(path) === completedPairs && completedPairs < BYTE_PRESSURE_COMPLETED_PAIRS) {
      const identity = `pair-${completedPairs}`;
      const selected = await committed(path, maximumSelection(identity));
      await committed(path, maximumCompactableTerminal(identity, selected));
      completedPairs += 1;
    }
    const retainedCompletedPairs = retainedCompletedPairCount(path);
    expect(retainedCompletedPairs).toBeLessThan(completedPairs);
    expect(retainedCompletedPairs).toBeLessThanOrEqual(MAX_COMPLETED_HANDOFF_ROUTING_PAIRS);

    const admitted = await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [
      maximumSelection('admitted'),
    ]);
    const closedOpening = await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [
      maximumCompactableTerminal('opening', 1),
    ]);
    const closedAdmission =
      admitted.kind === 'committed'
        ? await publishGenerationCoordinatedHandoffRoutingTransitions(runtime, path, [
            maximumCompactableTerminal('admitted', admitted.sequence),
          ])
        : undefined;

    expect({ admitted, closedOpening, closedAdmission }).toEqual({
      admitted: expect.objectContaining({ kind: 'committed' }),
      closedOpening: expect.objectContaining({ kind: 'committed' }),
      closedAdmission: expect.objectContaining({ kind: 'committed' }),
    });
  });
});
