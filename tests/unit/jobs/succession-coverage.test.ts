import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { certifySuccessionJobCoverage, readSuccessionLiveJobIds } from '#src/jobs/succession-coverage.js';
import type { Database } from '#src/store/db.js';

describe('succession job coverage', () => {
  it('includes every crash-recovery non-terminal phase and identities without status rows', () => {
    const db = new DatabaseSync(':memory:');
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

      const live = readSuccessionLiveJobIds(db as Database, ['pending'], ['external']);
      expect(new Set(live)).toEqual(new Set(['queued', 'running', 'unknown', 'pending', 'external']));
      expect(certifySuccessionJobCoverage(live, new Map([['external', ['provider-hosts']]]))).toContain('unclaimed: pending');
      expect(certifySuccessionJobCoverage(['external'], new Map([['external', ['provider-hosts']]]))).toEqual([]);
    } finally {
      db.close();
    }
  });
});
