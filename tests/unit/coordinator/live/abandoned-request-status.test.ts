import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  readAbandonedRequestStatus,
  reconcileAbandonedRequestStatuses,
  writeAbandonedRequestStatus,
} from '#src/infra/abandoned-request-status.js';
import type { ProcessIncarnation } from '#src/infra/node-process.js';

import { createRealRuntime } from '#src/runtime/real.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('abandoned request status', () => {
  it('preserves additive fields when an abandoned request settles', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-abandoned-additive-'));
    roots.push(runDir);
    const storage = createRealRuntime('prod').storage;
    const request = {
      recordId: 'request-1',
      method: 'jobs.detail',
      requestId: 'request-1',
      startedAt: '2026-09-27T00:00:00.000Z',
      outcome: 'continuing' as const,
      identity: { jobId: 'job-1' },
    };
    writeAbandonedRequestStatus(storage, runDir, request);
    const path = join(runDir, 'abandoned-requests.v1', 'request-1.json');
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      path,
      `${JSON.stringify({ ...stored, futureField: 'keep', identity: { jobId: 'job-1', futureIdentity: 'keep' } })}\n`,
    );
    writeAbandonedRequestStatus(storage, runDir, { ...request, outcome: 'completed' });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      outcome: 'completed',
      futureField: 'keep',
      identity: { futureIdentity: 'keep' },
    });
    expect(readAbandonedRequestStatus(storage, runDir, request.recordId)).toMatchObject({
      kind: 'found',
      status: { outcome: 'completed', futureField: 'keep', identity: { futureIdentity: 'keep' } },
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

  it('leaves a continuing request with malformed owner identity unreadable', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'coral-abandoned-invalid-owner-'));
    roots.push(runDir);
    const storage = createRealRuntime('prod').storage;
    writeAbandonedRequestStatus(storage, runDir, {
      recordId: 'invalid-owner',
      method: 'jobs.detail',
      requestId: 'request-1',
      startedAt: '2026-09-27T00:00:00.000Z',
      outcome: 'continuing',
    });
    writeFileSync(
      join(runDir, 'abandoned-requests.v1', 'invalid-owner.json'),
      JSON.stringify({
        version: 1,
        recordId: 'invalid-owner',
        method: 'jobs.detail',
        requestId: 'request-1',
        startedAt: '2026-09-27T00:00:00.000Z',
        outcome: 'continuing',
        owner: { instanceId: 'coordinator', pid: process.pid, incarnation: null },
      }),
    );
    expect(readAbandonedRequestStatus(storage, runDir, 'invalid-owner')).toEqual({ kind: 'unreadable' });
    expect(reconcileAbandonedRequestStatuses(storage, runDir).updated).toBe(0);
    expect(readAbandonedRequestStatus(storage, runDir, 'invalid-owner')).toEqual({ kind: 'unreadable' });
  });
});
