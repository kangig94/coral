import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readAbandonedRequestStatus,
  reconcileAbandonedRequestStatuses,
  writeAbandonedRequestStatus,
} from '#src/infra/abandoned-request-status.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';
import { createRequestLeaseOwner } from '#src/coordinator/live/request-leases.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createRealTimePort } from '#src/infra/time.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('abandoned request status', () => {
  it('retains more than 256 concurrently abandoned requests and makes each outcome readable by record ID', async () => {
    vi.useFakeTimers();
    const runDir = mkdtempSync(join(tmpdir(), 'coral-abandoned-requests-'));
    roots.push(runDir);
    const storage = createRealRuntime('prod').storage;
    let nextRecord = 0;
    const owner = createRequestLeaseOwner({
      begin: () => {},
      end: () => {},
      time: createRealTimePort(),
      newRecordId: () => `request-${nextRecord++}`,
      timing: { defaultMs: 40, kbMutationMs: 400, settleMs: 10, checkMs: 2, schedulingGapMs: 20 },
      abandon: (request) => writeAbandonedRequestStatus(storage, runDir, request),
    });
    const requests = Array.from({ length: 257 }, (_, index) =>
      owner.begin('jobs.detail', `request-${index}`).run(() => new Promise<never>(() => {})),
    );
    const outcomes = Promise.allSettled(requests);
    await vi.advanceTimersByTimeAsync(60);
    expect((await outcomes).every((outcome) => outcome.status === 'rejected')).toBe(true);
    expect(readdirSync(join(runDir, 'abandoned-requests.v1'))).toHaveLength(257);
    expect(readAbandonedRequestStatus(storage, runDir, 'request-0')).toMatchObject({
      kind: 'found',
      status: { outcome: 'continuing' },
    });
    writeAbandonedRequestStatus(storage, runDir, {
      recordId: 'request-0',
      method: 'jobs.detail',
      requestId: 'request-0',
      startedAt: new Date().toISOString(),
      outcome: 'completed',
    });
    expect(readAbandonedRequestStatus(storage, runDir, 'request-0')).toMatchObject({
      kind: 'found',
      status: { outcome: 'completed' },
    });
  });

  it('prunes only terminal records', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-abandoned-terminal-'));
    roots.push(runDir);
    const storage = createRealRuntime('prod').storage;
    writeAbandonedRequestStatus(storage, runDir, {
      recordId: 'still-running',
      method: 'jobs.detail',
      requestId: 'still-running',
      startedAt: '2026-09-27T00:00:00.000Z',
      outcome: 'continuing',
    });
    for (let index = 0; index < 257; index += 1) {
      writeAbandonedRequestStatus(storage, runDir, {
        recordId: `terminal-${index}`,
        method: 'jobs.detail',
        requestId: `terminal-${index}`,
        startedAt: '2026-09-27T00:00:00.000Z',
        outcome: 'completed',
      });
    }
    expect(readdirSync(join(runDir, 'abandoned-requests.v1'))).toHaveLength(257);
    expect(readAbandonedRequestStatus(storage, runDir, 'still-running')).toMatchObject({
      kind: 'found',
      status: { outcome: 'continuing' },
    });
  });

  it('reconciles continuing work after its exact owner incarnation has exited', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-abandoned-owner-exit-'));
    roots.push(runDir);
    const storage = createRealRuntime('prod').storage;
    writeAbandonedRequestStatus(storage, runDir, {
      recordId: 'owner-exited',
      method: 'jobs.detail',
      requestId: 'request-1',
      startedAt: '2026-09-27T00:00:00.000Z',
      outcome: 'continuing',
      owner: {
        instanceId: 'old-coordinator',
        pid: process.pid,
        incarnation: 'different-incarnation' as ProcessIncarnation,
      },
    });
    reconcileAbandonedRequestStatuses(storage, runDir);
    expect(readAbandonedRequestStatus(storage, runDir, 'owner-exited')).toMatchObject({
      kind: 'found',
      status: { outcome: 'owner_exited' },
    });
  });
});
