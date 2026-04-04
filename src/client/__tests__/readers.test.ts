import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// JOBS_DIR is the module-level constant tmpdir()/coral-jobs — not overridable without
// mocking the paths module. Tests write unique job IDs here and clean up in afterEach.
// Risk: if a test worker is killed before cleanup, a test-* directory remains in the
// production jobs path. This is acceptable because job IDs are unique and the directory
// contains only test fixtures, not real job state.
const jobsDir = join(tmpdir(), 'coral-jobs');
import { readStatusRecord, readProgressLog } from '../readers.js';

let testJobId: string;
let testJobDir: string;

beforeEach(() => {
  testJobId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  testJobDir = join(jobsDir, testJobId);
  mkdirSync(testJobDir, { recursive: true });
});

afterEach(() => {
  rmSync(testJobDir, { recursive: true, force: true });
});

describe('readStatusRecord', () => {
  const validStatus = {
    jobId: 'j1',
    sessionId: 's1',
    provider: 'codex',
    projectRoot: '/tmp/project',
    backendNamespace: 'ns',
    phase: 'completed',
    launch: { state: 'ready', updatedAt: '2026-01-01T00:00:00Z' },
  };

  it('returns a valid status record with all required fields', () => {
    writeFileSync(join(testJobDir, 'status.json'), JSON.stringify(validStatus));
    const result = readStatusRecord(testJobId);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe('j1');
    expect(result!.sessionId).toBe('s1');
    expect(result!.provider).toBe('codex');
    expect(result!.projectRoot).toBe('/tmp/project');
    expect(result!.backendNamespace).toBe('ns');
    expect(result!.phase).toBe('completed');
    expect(result!.launch.state).toBe('ready');
    expect(result!.launch.updatedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns null for missing file', () => {
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    writeFileSync(join(testJobDir, 'status.json'), 'not json');
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for valid JSON with wrong shape (string)', () => {
    writeFileSync(join(testJobDir, 'status.json'), '"just a string"');
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for valid JSON with missing required fields', () => {
    writeFileSync(join(testJobDir, 'status.json'), JSON.stringify({ jobId: 'j1' }));
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('returns null for valid JSON with wrong nested shape (launch as string)', () => {
    writeFileSync(
      join(testJobDir, 'status.json'),
      JSON.stringify({ ...validStatus, launch: 'not an object' }),
    );
    expect(readStatusRecord(testJobId)).toBeNull();
  });

  it('accepts and preserves additional fields (forward compatibility)', () => {
    const extended = { ...validStatus, futureField: true };
    writeFileSync(join(testJobDir, 'status.json'), JSON.stringify(extended));
    const result = readStatusRecord(testJobId);
    expect(result).not.toBeNull();
    expect(result!.jobId).toBe('j1');
    expect(result!).toHaveProperty('futureField', true);
  });
});

describe('readProgressLog', () => {
  const validLine = {
    jobId: 'j1',
    sessionId: 's1',
    eventId: 1,
    type: 'progress',
    ts: '2026-01-01T00:00:00Z',
    message: 'working',
  };

  it('returns valid progress entries with all required fields', () => {
    writeFileSync(join(testJobDir, 'progress.jsonl'), JSON.stringify(validLine) + '\n');
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].jobId).toBe('j1');
    expect(result[0].sessionId).toBe('s1');
    expect(result[0].eventId).toBe(1);
    expect(result[0].type).toBe('progress');
    expect(result[0].ts).toBe('2026-01-01T00:00:00Z');
    expect(result[0].message).toBe('working');
  });

  it('returns empty array for missing file', () => {
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('skips lines with invalid JSON', () => {
    const content = [JSON.stringify(validLine), 'not json', JSON.stringify({ ...validLine, eventId: 2 })].join('\n');
    writeFileSync(join(testJobDir, 'progress.jsonl'), content);
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(2);
  });

  it('skips lines with wrong shape (missing required fields)', () => {
    const badLine = { jobId: 'j1' }; // missing sessionId, eventId, type, ts
    const content = [JSON.stringify(validLine), JSON.stringify(badLine)].join('\n');
    writeFileSync(join(testJobDir, 'progress.jsonl'), content);
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].eventId).toBe(1);
  });

  it('skips lines where eventId is not a number', () => {
    const badLine = { ...validLine, eventId: 'not-a-number' };
    const content = [JSON.stringify(validLine), JSON.stringify(badLine)].join('\n');
    writeFileSync(join(testJobDir, 'progress.jsonl'), content);
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
  });

  it('accepts and preserves additional fields (forward compatibility)', () => {
    const extended = { ...validLine, futureField: 'data' };
    writeFileSync(join(testJobDir, 'progress.jsonl'), JSON.stringify(extended) + '\n');
    const result = readProgressLog(testJobId);
    expect(result).toHaveLength(1);
    expect(result[0].jobId).toBe('j1');
    expect(result[0]).toHaveProperty('futureField', 'data');
  });

  it('returns empty array for empty file', () => {
    writeFileSync(join(testJobDir, 'progress.jsonl'), '');
    expect(readProgressLog(testJobId)).toEqual([]);
  });

  it('returns empty array for whitespace-only file', () => {
    writeFileSync(join(testJobDir, 'progress.jsonl'), '\n\n  \n');
    expect(readProgressLog(testJobId)).toEqual([]);
  });
});
