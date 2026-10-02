import { describe, expect, it } from 'vitest';

import { classifyCarrier, type CarrierEvidence, type CarrierObservationInput } from '#src/jobs/carrier-observation.js';

function observe(evidence: CarrierEvidence, overrides: Partial<CarrierObservationInput> = {}) {
  return classifyCarrier({
    storedPhase: 'running',
    evidence,
    observedMaxJournalSeq: 7,
    recoveryCoverage: 'in-progress',
    ...overrides,
  });
}

describe('classifyCarrier', () => {
  it('reports a local unknown after the recovery decision as the defect it is', () => {
    const observation = observe(
      { carrierClass: 'app-server-acquired', registryState: 'inherited' },
      { recoveryCoverage: 'unaccounted' },
    );

    // Startup recovery is what bounds local unknowns, so one surviving it means recovery skipped a job it
    // owned. The verdict still holds the job open — reporting the defect must not also change the answer.
    expect(observation.defect).toBe('local-unknown-after-recovery-decision');
    expect(observation.liveness).toBe('unknown');
  });

  describe('durable CLI', () => {
    const recorded = (overrides: Partial<{ alive: boolean; matchesRecordedIncarnation: boolean }>) =>
      observe({
        carrierClass: 'durable-cli',
        process: {
          kind: 'recorded',
          alive: true,
          matchesRecordedIncarnation: true,
          ...overrides,
        },
      });

    it('refuses to call a recycled pid live', () => {
      // The pid is alive and is not this job; pid liveness alone is explicitly insufficient.
      expect(recorded({ matchesRecordedIncarnation: false }).liveness).toBe('absent');
    });

    it('is unknown when the launch never captured its process identity', () => {
      const observation = observe({ carrierClass: 'durable-cli', process: { kind: 'uncaptured' } });

      // Nothing was learned about the child, only about the record — the one thing that must not read as
      // absence, since the child may be running perfectly well.
      expect(observation.liveness).toBe('unknown');
      expect(observation.source).toBe('no-local-evidence');
    });
  });
});
