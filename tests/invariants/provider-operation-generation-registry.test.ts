import { describe, expect, it } from 'vitest';

import { PROVIDER_OPERATION_RECORD_GENERATIONS } from '#src/store/provider-operation-record.js';
import { STORE_RESET_INCIDENT_SCHEMA_GENERATIONS } from '#src/store/reset-incident.js';
import { CORPUS_PROJECTION_COMMIT_SCHEMA_GENERATIONS } from '#src/kb/corpus/projection-lifecycle.js';

describe('other durable and wire generations', () => {
  // A registry of two independent fields reads as one owner and is not: raising `current` while leaving
  // `retained` behind compiles, and the generation between them is then neither decoded nor fenced — the exact
  // defect these registries exist to prevent. TypeScript cannot express the constraint without losing the
  // literal types that `z.literal` and every downstream narrowing depend on, so it is asserted here instead.
  it('keeps every generation registry contiguous, ordered and disjoint from its current', () => {
    const registries: readonly Readonly<{ name: string; retained: readonly number[]; current: number }>[] = [
      {
        name: 'PROVIDER_OPERATION_RECORD_GENERATIONS',
        retained: PROVIDER_OPERATION_RECORD_GENERATIONS.retainedSuperseded,
        current: PROVIDER_OPERATION_RECORD_GENERATIONS.current,
      },
      {
        name: 'STORE_RESET_INCIDENT_SCHEMA_GENERATIONS',
        retained: STORE_RESET_INCIDENT_SCHEMA_GENERATIONS.retainedReadable,
        current: STORE_RESET_INCIDENT_SCHEMA_GENERATIONS.current,
      },
      {
        name: 'CORPUS_PROJECTION_COMMIT_SCHEMA_GENERATIONS',
        retained: CORPUS_PROJECTION_COMMIT_SCHEMA_GENERATIONS.retainedSupported,
        current: CORPUS_PROJECTION_COMMIT_SCHEMA_GENERATIONS.current,
      },
    ];

    for (const { name, retained, current } of registries) {
      const sequence = [...retained, current];
      // Deliberately not "must retain at least one": an empty retained window is legitimate once no build that
      // wrote the previous generation can still be in the field, and the journal's own doc says so. What must
      // hold is that a *retained* window is contiguous with the current generation and does not contain it.
      expect(retained, `${name}'s current generation must not also be retained`).not.toContain(current);
      expect(sequence, `${name} must be ordered oldest-first with no gap`).toEqual(
        Array.from({ length: sequence.length }, (_, index) => sequence[0] + index),
      );
    }
  });
});
