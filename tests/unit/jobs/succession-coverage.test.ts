import { describe, expect, it } from 'vitest';

import { certifySuccessionJobCoverage } from '#src/coordinator/succession/obligations.js';
import { readSuccessionCustodyJobIds, readSuccessionLiveJobIds } from '#src/jobs/succession-coverage.js';
import type { CustodyEntry, CustodyIntent } from '#src/store/custody-ledger.js';
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

      const live = readSuccessionLiveJobIds(db, ['pending'], ['external'], []);
      expect(new Set(live)).toEqual(new Set(['queued', 'running', 'unknown', 'pending', 'external']));
      expect(certifySuccessionJobCoverage(live, new Map([['external', ['provider-hosts']]]))).toContain(
        'unclaimed: pending',
      );
      expect(certifySuccessionJobCoverage(['external'], new Map([['external', ['provider-hosts']]]))).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('should cover a job whose spawned process custody has not been bound or proven absent', () => {
    const intent = (id: string, overrides: Partial<CustodyIntent>): CustodyIntent => ({
      version: 'v1',
      id,
      effect: 'process-spawn',
      epoch: '/store/epoch-2',
      epochKey: 'lineage:2',
      owner: 'durable-cli',
      operationId: `job-${id}`,
      processToken: '00000000-0000-4000-8000-000000000000',
      capsule: null,
      createdAtMs: 1,
      bindDeadlineMs: 2,
      ...overrides,
    });
    const scope = { epochPath: '/store/epoch-2', lineageKey: 'lineage:2' };
    const entries: CustodyEntry[] = [
      { kind: 'holding', intent: intent('a', {}), exit: 'identity-binding-or-proven-absence' },
      {
        kind: 'holding',
        intent: intent('b', { effect: 'provider-operation-publication', owner: 'provider-operations', jobId: 'job-p' }),
        exit: 'identity-binding-or-proven-absence',
      },
      {
        kind: 'holding',
        intent: intent('c', { epochKey: undefined, epoch: '/store/epoch-2' }),
        exit: 'identity-binding-or-proven-absence',
      },
      { kind: 'holding', intent: intent('d', { epochKey: 'lineage:1' }), exit: 'identity-binding-or-proven-absence' },
      { kind: 'absent', intent: intent('e', {}), evidence: 'token absent' },
      {
        kind: 'holding',
        intent: intent('f', { owner: 'provider-proxy-set', operationId: 'proxy:guardian' }),
        exit: 'identity-binding-or-proven-absence',
      },
    ];

    expect(new Set(readSuccessionCustodyJobIds(entries, scope))).toEqual(new Set(['job-a', 'job-p', 'job-c']));
    expect(() =>
      readSuccessionCustodyJobIds(
        [...entries, { kind: 'unreadable', path: '/run/custody.v1/x', reason: 'EIO' }],
        scope,
      ),
    ).toThrow();
    const db = newRawDatabase(':memory:');
    try {
      db.exec('CREATE TABLE projection_jobs (job_id TEXT, phase TEXT)');
      const live = readSuccessionLiveJobIds(db, [], [], readSuccessionCustodyJobIds(entries, scope));
      expect(certifySuccessionJobCoverage(live, new Map())).toContain('unclaimed: job-a');
    } finally {
      db.close();
    }
  });
});
