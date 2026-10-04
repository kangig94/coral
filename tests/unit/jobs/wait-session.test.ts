import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { describe, expect, it } from 'vitest';
import { WaitSession } from '#src/jobs/wait-session.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait-cursor.js';
import { selectWaitSnapshot } from '#src/jobs/wait-snapshot.js';

describe('wait session', () => {
  it('consumes an epoch prefix without skipping an interleaved sibling or hiding its terminal', () => {
    const session = new WaitSession(['a', 'b']);
    session.reconcile([
      admitted('a', [
        [1, 'a1'],
        [3, 'a3'],
      ]),
      admitted('b', [
        [2, 'b2'],
        [4, 'b4'],
      ]),
    ]);
    session.consume(session.progress()[0]);
    expect(session.progress().map((line) => line.text)).toEqual(['b2', 'a3', 'b4']);
    session.acknowledge(session.admissions[0]);
    expect(session.remaining()).toEqual(['a', 'b']);
    const resumed = new WaitSession(['b', 'a'], session.cursor());
    resumed.reconcile([...session.admissions].reverse());
    expect(resumed.progress().map((line) => line.text)).toEqual(['b2', 'a3', 'b4']);
    expect(resumed.acknowledged('a')).toBe(true);
    expect(resumed.acknowledged('b')).toBe(false);
    expect(resumed.notices).toEqual([]);
  });

  it('preserves acknowledgement and artifact settlement independently of unread progress', () => {
    const a = admitted('a', [[1, 'one\ntwo\n']]);
    a.availability = { kind: 'repair-pending', ageUncertain: false };
    const session = new WaitSession(['a']);
    session.reconcile([a]);
    session.acknowledge(a);
    expect(session.progress().map((line) => line.text)).toEqual(['one', 'two']);
    session.consume(session.progress()[0]);
    const resumed = new WaitSession(['a'], session.cursor());
    resumed.reconcile([a]);
    expect(resumed.progress().map((line) => line.text)).toEqual(['two']);
    expect(resumed.acknowledged('a')).toBe(true);
    expect(resumed.artifactPending('a')).toBe(true);
    expect(resumed.remaining()).toEqual(['a']);
    resumed.consume(resumed.progress()[0]);
    expect(resumed.remaining()).toEqual(['a']);
    resumed.settleArtifact('a');
    expect(resumed.remaining()).toEqual([]);
  });

  it.each(['snapshot-to-stream', 'stream-to-snapshot'])(
    'resets new or unresolved epoch membership once on %s without losing flags',
    (direction) => {
      const a = admitted('a', [[100, 'a100']]);
      a.availability = { kind: 'repair-pending', ageUncertain: false };
      const session = new WaitSession(['a', 'u']);
      session.reconcile([a, { jobId: 'u', disposition: 'discovery-unknown' }]);
      const cursor =
        direction === 'snapshot-to-stream'
          ? selectWaitSnapshot(session, 20).cursor
          : (() => {
              session.consume(session.progress()[0]);
              session.acknowledge(a);
              return session.cursor();
            })();
      expect(cursor.jobs.find((job) => job.hash === waitJobHash('u'))).toMatchObject({ epoch: 255, flags: 0 });
      const joined = [a, admitted('u', [[2, 'u below 100']], false)];
      const resumed = new WaitSession(['a', 'u'], cursor);
      resumed.reconcile(joined);
      expect(resumed.progress().map((line) => line.text)).toEqual(['u below 100', 'a100']);
      expect(resumed.notices).toEqual([expect.stringContaining('membership changed')]);
      expect(resumed.acknowledged('a')).toBe(true);
      expect(resumed.artifactPending('a')).toBe(true);
      const next = new WaitSession(['u', 'a'], resumed.cursor());
      next.reconcile([...joined].reverse());
      expect(next.notices).toEqual([]);
      expect(next.acknowledged('a')).toBe(true);
    },
  );

  it('uses request-order failure and refusal precedence; excludes missing but retains retryable discovery', () => {
    const a = admitted('a');
    const session = new WaitSession(['a', 'ghost', 'u', 'b']);
    session.reconcile([
      a,
      { jobId: 'ghost', disposition: 'missing' },
      { jobId: 'u', disposition: 'discovery-unknown' },
      admitted('b', [], false),
    ]);
    session.acknowledge(a);
    expect(session.remaining()).toEqual(['u', 'b']);
    expect(session.cursor(session.remaining()).jobs).toHaveLength(2);
    expect(session.exitCode()).toBe(1);
    session.reconcile([admitted('a', [], true, 'epoch-E', true), ...session.admissions.slice(1)]);
    expect(session.exitCode()).toBe(42);
    const successful = new WaitSession(['a', 'b']);
    successful.reconcile([a, admitted('b', [], false)]);
    successful.acknowledge(a);
    expect(successful.exitCode()).toBe(75);
  });

  it('retains unknown coverage until a complete observation publishes it', () => {
    const session = new WaitSession(['a', 'b']);
    session.reconcile([admitted('a', [], false), admitted('b', [], false)]);
    expect(session.unknownCarriers()).toEqual(['a', 'b']);
    session.observeCoverage(['a', 'b'], ['b'], 9);
    expect(session.unknownCarriers()).toEqual(['b']);
    session.observeAbsent('b', 10);
    expect(session.remaining()).toEqual(['a', 'b']);
    expect(session.exitCode()).toBe(75);
    expect(session.cursor().epochs[0].token).toBe(waitEpochToken('epoch-E'));
  });
});

it.each([false, true])(
  'retained history cannot supply progress or an unvalidated outcome without a successful source read, corrupt=%s',
  (corrupt) => {
    const h = admitted('h', [[1, 'retained progress']], true, 'old');
    const detail = h.detail!;
    detail.status.updatedAt = '2026-10-04T00:00:00Z';
    detail.exit!.endTime = detail.status.updatedAt;
    for (const event of detail.events) {
      event.ts = detail.status.updatedAt;
      event.sessionId = detail.status.sessionId;
    }
    if (corrupt) detail.exit!.content = 'corrupted copy';
    const location = {
      version: 'v1',
      jobId: 'h',
      epochKey: 'old',
      subject: { projectRoot: '/tmp', workDir: '/tmp', jobKind: 'provider' },
      disposition: 'terminal',
      terminalSeq: 1000,
      detail: { kind: 'recorded', value: detail },
    };
    const reader = new JobAddressing(
      { time: createRealTimePort(), read: () => location, unknownLocationHolds: () => [] } as never,
      { epochKey: () => 'active', detail: () => null } as never,
      () => false,
      () => 'decided',
      () => ({ kind: 'unreadable', retired: true }),
      () => ({ kind: 'retained-away', retentionDays: 14 }),
    );
    const snapshot = reader.snapshot({ jobIds: ['h'], projectRoot: '/tmp' });
    expect(snapshot.jobs[0].progress).toEqual([]);
    expect(snapshot.notices).toContain('earlier progress for h is no longer kept');
    if (corrupt) {
      expect(snapshot.jobs[0].terminal).toBeUndefined();
      expect(snapshot.remainingJobIds).toEqual(['h']);
      expect(snapshot.exitCode).toBe(75);
    } else expect(snapshot.jobs[0].terminal).toBeDefined();
  },
);

it('translates a released acknowledgement into pending artifact collection without replaying its outcome', () => {
  const a = admitted('a');
  a.availability = { kind: 'repair-pending', ageUncertain: false };
  const session = new WaitSession(['a'], {
    version: 'jobs.wait.v2',
    positions: { 'epoch-E': 0 },
    locations: { a: 'epoch-E' },
    deliveredJobIds: ['a'],
  });
  session.reconcile([a]);
  const snapshot = selectWaitSnapshot(session);
  expect(snapshot.jobs[0].terminal).toBeUndefined();
  expect(snapshot.jobs[0].alreadyCollected).toBe(true);
  expect(snapshot.remainingJobIds).toEqual(['a']);
  expect(snapshot.cursor.jobs[0].flags).toBe(3);
});

it('unrecorded versionless membership replays progress while keeping recorded terminal acknowledgements', () => {
  const a = admitted('a', [[100, 'a100']]);
  const u = admitted('u', [[2, 'u2']], false);
  const session = new WaitSession(['a', 'u'], { afterSeq: 100, deliveredJobIds: ['a'] }, 'epoch-E');
  session.reconcile([a, u]);
  expect(session.progress().map((line) => line.text)).toEqual(['u2', 'a100']);
  expect(session.acknowledged('a')).toBe(true);
  expect(session.notices).toEqual([expect.stringContaining('membership changed')]);
});
