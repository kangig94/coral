import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PersistedStatusRecord, TerminalResult } from '../../types.js';
import { JOBS_DIR, ProgressStore, createReplayCursor } from '../progress-store.js';

const jobIdsToClean = new Set<string>();
const renameCalls = vi.hoisted(() => [] as Array<[unknown, unknown]>);

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renameCalls.push([args[0], args[1]]);
      return actual.renameSync(...args);
    },
  };
});

afterEach(() => {
  for (const jobId of jobIdsToClean) {
    rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
  }
  jobIdsToClean.clear();
  renameCalls.length = 0;
  vi.restoreAllMocks();
});

describe('execution ProgressStore', () => {
  it('initJob creates directory and status.json with phase launching', () => {
    const store = new ProgressStore();
    const jobId = `progress-init-${randomUUID()}`;
    jobIdsToClean.add(jobId);

    store.initJob(jobId, 'session-1', 'codex');

    expect(existsSync(store.jobDir(jobId))).toBe(true);
    expect(store.readStatus(jobId)).toMatchObject({
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      phase: 'launching',
      launch: { state: 'pending' },
    });
  });

  it('appendProgress returns incrementing eventId starting at 1', () => {
    const store = new ProgressStore();
    const jobId = `progress-events-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob(jobId, 'session-1', 'codex');

    const first = store.appendProgress(jobId, 'session-1', 'first');
    const second = store.appendProgress(jobId, 'session-1', 'second');

    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it('replayFrom returns only events with eventId greater than fromEventId', () => {
    const store = new ProgressStore();
    const jobId = `progress-replay-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob(jobId, 'session-1', 'codex');
    store.appendProgress(jobId, 'session-1', 'first');
    store.appendProgress(jobId, 'session-1', 'second');
    store.appendProgress(jobId, 'session-1', 'third');

    const events = store.replayFrom(jobId, 1, createReplayCursor());

    expect(events.map((event) => event.eventId)).toEqual([2, 3]);
    expect(events.map((event) => event.message)).toEqual(['second', 'third']);
  });

  it('appendTerminal updates status.json result', () => {
    const store = new ProgressStore();
    const jobId = `progress-terminal-${randomUUID()}`;
    const result = { content: 'done', exitCode: 0 } satisfies TerminalResult;
    jobIdsToClean.add(jobId);
    store.initJob(jobId, 'session-1', 'codex');

    store.appendTerminal(jobId, 'session-1', result, 'completed');

    expect(store.readStatus(jobId)).toMatchObject({
      phase: 'completed',
      result,
    });
  });

  it('writeStatus is atomic (write to .tmp then rename)', () => {
    const store = new ProgressStore();
    const jobId = `progress-atomic-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob(jobId, 'session-1', 'codex');

    renameCalls.length = 0;

    const record = {
      jobId,
      sessionId: 'session-1',
      provider: 'codex',
      phase: 'running',
      launch: {
        state: 'ready',
        updatedAt: '2026-03-06T00:00:00.000Z',
      },
    } satisfies PersistedStatusRecord;

    store.writeStatus(jobId, record);

    expect(renameCalls).toContainEqual([
      join(store.jobDir(jobId), 'status.json.tmp'),
      join(store.jobDir(jobId), 'status.json'),
    ]);
    expect(existsSync(join(store.jobDir(jobId), 'status.json.tmp'))).toBe(false);
    expect(JSON.parse(readFileSync(join(store.jobDir(jobId), 'status.json'), 'utf-8'))).toEqual(record);
  });

  it('replayFrom from eventId=0 on a job with only a terminal event returns that terminal', () => {
    const store = new ProgressStore();
    const jobId = `progress-terminal-only-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob(jobId, 'session-1', 'codex');
    store.appendTerminal(jobId, 'session-1', { content: 'result text' }, 'completed');

    const events = store.replayFrom(jobId, 0, createReplayCursor());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('terminal');
    expect(events[0].result?.content).toBe('result text');
  });

  it('appendTerminal is safe when status.json does not exist (no unhandled throw)', () => {
    const store = new ProgressStore();
    const jobId = `progress-nostatus-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    mkdirSync(store.jobDir(jobId), { recursive: true });
    writeFileSync(join(store.jobDir(jobId), 'progress.jsonl'), '', 'utf-8');

    expect(() => {
      store.appendTerminal(jobId, 'session-1', { content: 'done' }, 'completed');
    }).not.toThrow();
  });

  it('consecutive replayFrom calls on the same cursor only return newly appended events', () => {
    const store = new ProgressStore();
    const jobId = `progress-cursor-advance-${randomUUID()}`;
    jobIdsToClean.add(jobId);
    store.initJob(jobId, 'session-1', 'codex');
    store.appendProgress(jobId, 'session-1', 'first');
    store.appendProgress(jobId, 'session-1', 'second');

    const cursor = createReplayCursor();
    const batch1 = store.replayFrom(jobId, 0, cursor);
    expect(batch1.map((e) => e.message)).toEqual(['first', 'second']);

    store.appendProgress(jobId, 'session-1', 'third');

    const batch2 = store.replayFrom(jobId, 2, cursor);
    expect(batch2.map((e) => e.message)).toEqual(['third']);
    expect(batch2.map((e) => e.eventId)).toEqual([3]);
  });
});
