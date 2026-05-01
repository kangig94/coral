// Spec §7.1 + §13.1 invariant: every registered Journal event type can be a
// causeRef target, so every type must have a matching describer keyed
// `${stream.kind}:${type}` in the default describer map. This is a structural
// test — runs at compile/test time without booting the coordinator.

import { describe, expect, it } from 'vitest';

import { CoralSetupError } from '#src/runtime/errors.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { assertDescriberCoverage, defaultEventDescribers } from '#src/read-model/event-describers.js';

describe('describer coverage invariant', () => {
  it('every registered Journal event type has a default describer', () => {
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const missing = reducers.describerKeys.filter((key) => !defaultEventDescribers.has(key));
    expect(missing).toEqual([]);
  });

  it('assertDescriberCoverage passes for the canonical registries', () => {
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    expect(() => assertDescriberCoverage(reducers.describerKeys)).not.toThrow();
  });

  it('assertDescriberCoverage throws CoralSetupError("describer_missing") on mismatch', () => {
    const synthetic = ['job:job.invented_event_for_test'];
    expect(() => assertDescriberCoverage(synthetic)).toThrow(CoralSetupError);
    try {
      assertDescriberCoverage(synthetic);
    } catch (error) {
      expect(error).toBeInstanceOf(CoralSetupError);
      expect((error as CoralSetupError).code).toBe('describer_missing');
      expect((error as CoralSetupError).context?.missing).toEqual(synthetic);
    }
  });
});
