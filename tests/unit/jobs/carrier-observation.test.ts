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
  it('carries stored phase and journal position through untouched', () => {
    const observation = observe(
      {
        carrierClass: 'durable-cli',
        process: { kind: 'recorded', alive: false, matchesRecordedIncarnation: false },
      },
      { storedPhase: 'launching', observedMaxJournalSeq: 41 },
    );

    // Observation is allowed to disagree with stored lifecycle; it is never allowed to restate it. A
    // classifier that "corrected" the phase here would make a read into a write of derived state.
    expect(observation.storedPhase).toBe('launching');
    expect(observation.observedMaxJournalSeq).toBe(41);
    expect(observation.liveness).toBe('absent');
  });

  it('reads an inherited operation as unknown rather than absent', () => {
    const observation = observe({ carrierClass: 'app-server-acquired', registryState: 'inherited' });

    // Complete runtime meta with no local entry means a predecessor build activated it, and that build's
    // proxy may still be running. The only proven fact is that *this* process has no entry.
    expect(observation.liveness).toBe('unknown');
    expect(observation.source).toBe('no-local-evidence');
    expect(observation.defect).toBeUndefined();
  });

  it.each(['activated', 'attached'] as const)('reads a locally %s operation as live', (registryState) => {
    expect(observe({ carrierClass: 'app-server-acquired', registryState }).liveness).toBe('live');
  });

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

  it.each(['in-progress', 'accounted-for'] as const)(
    'keeps an inherited operation defect-free while recovery coverage is %s',
    (recoveryCoverage) => {
      const observation = observe(
        { carrierClass: 'app-server-acquired', registryState: 'inherited' },
        { recoveryCoverage },
      );

      expect(observation.liveness).toBe('unknown');
      expect(observation.defect).toBeUndefined();
    },
  );

  it('does not report the defect for classes whose unknown recovery never claimed to bound', () => {
    const workflow = observe(
      { carrierClass: 'workflow', ownedByThisCoordinator: false },
      { recoveryCoverage: 'unaccounted' },
    );

    expect(workflow.liveness).toBe('unknown');
    expect(workflow.defect).toBeUndefined();
  });

  it('treats admission as the whole claim for jobs with no process or operation yet', () => {
    expect(observe({ carrierClass: 'queued-or-launching', admittedByThisCoordinator: true }).liveness).toBe('live');
    expect(observe({ carrierClass: 'app-server-waiting', admittedByThisCoordinator: true }).liveness).toBe('live');
    // No admission entry answers nothing about the job — an app-server job that has not acquired an
    // operation cannot be checked against an operation tuple, so assuming one would manufacture absence.
    expect(observe({ carrierClass: 'app-server-waiting', admittedByThisCoordinator: false }).liveness).toBe('unknown');
  });

  it('never concludes absence from KB supervisor non-membership', () => {
    const observation = observe({ carrierClass: 'internal-hosted-kb', memberOfSupervisor: false });

    // Daemon-online state is not membership, and membership is the only authority for this class.
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

    it('is live only when liveness and the recorded incarnation agree', () => {
      expect(recorded({}).liveness).toBe('live');
      expect(recorded({}).source).toBe('durable-cli-process');
    });

    it('refuses to call a recycled pid live', () => {
      // The pid is alive and is not this job; pid liveness alone is explicitly insufficient.
      expect(recorded({ matchesRecordedIncarnation: false }).liveness).toBe('absent');
    });

    it('is absent when the process is gone', () => {
      expect(recorded({ alive: false }).liveness).toBe('absent');
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
