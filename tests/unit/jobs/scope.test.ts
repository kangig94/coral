import { describe, expect, it } from 'vitest';

import { jobInCallerScope } from '#src/jobs/scope.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const CALLER = fixtureCanonicalWorkDir('/repo');
const CHILD = fixtureCanonicalWorkDir('/repo/sub');
const SIBLING = fixtureCanonicalWorkDir('/sibling');

describe('jobInCallerScope', () => {
  it('exempts a KB job from both relations, whatever it records', () => {
    for (const relation of ['contains', 'exact'] as const) {
      expect(jobInCallerScope({ jobKind: 'kb', workDir: null }, CALLER, relation)).toBe(true);
      expect(jobInCallerScope({ jobKind: 'kb', workDir: SIBLING }, CALLER, relation)).toBe(true);
    }
  });

  it('refuses a non-KB job that records no work directory', () => {
    for (const relation of ['contains', 'exact'] as const) {
      expect(jobInCallerScope({ jobKind: 'provider', workDir: null }, CALLER, relation)).toBe(false);
      expect(jobInCallerScope({ jobKind: 'workflow', workDir: null }, CALLER, relation)).toBe(false);
    }
  });

  it('selects containment or equality by relation, and is one-directional in both', () => {
    expect(jobInCallerScope({ jobKind: 'provider', workDir: CHILD }, CALLER, 'contains')).toBe(true);
    expect(jobInCallerScope({ jobKind: 'provider', workDir: CHILD }, CALLER, 'exact')).toBe(false);

    expect(jobInCallerScope({ jobKind: 'provider', workDir: CALLER }, CALLER, 'exact')).toBe(true);
    expect(jobInCallerScope({ jobKind: 'provider', workDir: CALLER }, CHILD, 'contains')).toBe(false);

    expect(jobInCallerScope({ jobKind: 'provider', workDir: SIBLING }, CALLER, 'contains')).toBe(false);
  });
});
