import { describe, expect, it } from 'vitest';

import { certifySuccessionJobCoverage } from '#src/coordinator/succession/obligations.js';
import { readSuccessionLiveJobIds } from '#src/jobs/succession-coverage.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

describe('succession job coverage', () => {
  it('includes a healthy local carrier in succession coverage even without a status row', () => {
    const db = newRawDatabase(':memory:');
    try {
      db.exec('CREATE TABLE projection_jobs (job_id TEXT, phase TEXT)');
      const live = readSuccessionLiveJobIds(db, [], ['carried-job'], []);
      expect(live).toEqual(['carried-job']);
      expect(certifySuccessionJobCoverage(live, new Map())).toEqual(['unclaimed: carried-job']);
      expect(certifySuccessionJobCoverage(live, new Map([['carried-job', ['provider-hosts']]]))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
