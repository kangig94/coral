import { describe, expect, it } from 'vitest';

import { certifySuccessionJobCoverage } from '#src/coordinator/succession/obligations.js';
import { readSuccessionLiveJobIds } from '#src/jobs/succession-coverage.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

describe('succession job coverage', () => {
  it('includes every crash-recovery non-terminal phase and identities without status rows', () => {
    const db = newRawDatabase(':memory:');
    try {
      db.exec('CREATE TABLE projection_jobs (job_id TEXT, phase TEXT)');
      for (const [jobId, phase] of [
        ['queued', 'queued'],
        ['running', 'running'],
        ['unknown', 'interrupted'],
        ['done', 'completed'],
      ]) {
        db.prepare('INSERT INTO projection_jobs VALUES (?, ?)').run(jobId, phase);
      }

      const live = readSuccessionLiveJobIds(db, ['pending'], ['external']);
      expect(new Set(live)).toEqual(new Set(['queued', 'running', 'unknown', 'pending', 'external']));
      expect(certifySuccessionJobCoverage(live, new Map([['external', ['provider-hosts']]]))).toContain(
        'unclaimed: pending',
      );
      expect(certifySuccessionJobCoverage(['external'], new Map([['external', ['provider-hosts']]]))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
