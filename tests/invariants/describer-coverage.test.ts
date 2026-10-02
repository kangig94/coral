// Spec §7.1 + §13.1 invariant: every registered Journal event type can be a
// causeRef target, so every type must have a matching describer keyed
// `${stream.kind}:${type}` in the default describer map. This is a structural
// test — runs at compile/test time without booting the coordinator.

import { describe, expect, it } from 'vitest';

import { discussRegistry } from '#src/discuss/event-registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { workflowRegistry } from '#src/workflow/events.js';
import { composeReducers } from '#src/store/reducers.js';
import { defaultEventDescribers } from '#src/read-model/event-describers.js';

describe('describer coverage invariant', () => {
  it('every registered Journal event type has a default describer', () => {
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const missing = reducers.describerKeys.filter((key) => !defaultEventDescribers.has(key));
    expect(missing).toEqual([]);
  });
});
