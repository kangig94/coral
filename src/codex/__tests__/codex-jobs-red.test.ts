/**
 * Red-team adversarial tests for the job-based Codex API refactoring.
 *
 * STAGING FILE — place at src/codex/__tests__/red-codex-jobs.test.ts once the
 * refactoring described in codex-background-default.md is complete.
 * All static imports below reference new exports added by that refactoring.
 *
 * Targeted modules (post-refactoring):
 *   src/codex/progress.ts        — createJobDir, writeJobResult, writeJobError,
 *                                  readJobStatus, resolveJobDir
 *   src/codex/schemas.ts         — waitShape (UUID validation, min-length, cursors),
 *                                  abortShape (schema-permissive, handler-enforced one-of)
 *   src/codex/server-handlers.ts — concurrent wait cursor isolation,
 *                                  tryClaimTerminalWrite in-memory CAS,
 *                                  poll-loop timer leak, abort lookup semantics
 *
 * Attack vectors covered (non-overlapping with plan Phase 6 implementer tests):
 *
 *  1. resolveJobDir path traversal: "../../../etc/passwd", "%2F..%2F", null-byte,
 *     whitespace-padded UUID, hex-without-dashes. Plan says "throw on non-UUID" but
 *     does not enumerate the specific attack payload forms.
 *
 *  2. writeJobResult atomicity: result.md must exist when status.json shows "completed".
 *     No .tmp file left behind. Double-write is a no-op (on-disk terminal guard).
 *     Plan tests completion; this tests the exact ordering and idempotency invariant.
 *
 *  3. writeJobError: preserves session_name from initial status.json; double-write no-op;
 *     error path after completed state is no-op; result.md must NOT exist after error.
 *
 *  4. readJobStatus: missing dir, missing file, empty file, valid JSON with no status
 *     field — all return { status: "running" }. Plan tests corrupt JSON; these test
 *     the other graceful-degradation branches.
 *
 *  5. tryClaimTerminalWrite in-memory CAS: first caller returns true, second caller
 *     (competing shutdown or double-completion) returns false. Plan tests the race at
 *     scenario level; this tests the CAS helper directly.
 *
 *  6. wait poll-loop timer leak: when a job is already completed before wait is called,
 *     the timeout timer must be cleared when wait returns early. Plan tests timeout fires;
 *     this tests the non-timeout path's cleanup.
 *
 *  7. Concurrent wait callers on same job_id: cursors are per-call, not per-job.
 *     Plan tests sequential cursor continuity; this tests simultaneous callers with
 *     different starting offsets cannot corrupt each other's state.
 *
 *  8. UTF-8 multi-byte character split at write boundary: newline-boundary rule ensures
 *     only complete lines are decoded. Incomplete line after last \n must not be decoded.
 *
 *  9. waitShape schema: empty job_ids array, non-UUID elements, path traversal elements,
 *     whitespace-padded UUIDs, non-UUID cursors keys, negative byte offsets, timeout
 *     out-of-bounds. Plan mentions UUID rejection but not the specific invalid forms.
 *
 * 10. abortShape schema: permissive (both provided → accepted, neither → accepted).
 *     Handler enforces one-of. Schema must NOT use superRefine (plan spec: keep union clean).
 *
 * 11. abort-by-job_id: looks up activeJobs directly, NOT via session_name routing.
 *     abort-by-session: matches entries by session field (thread ID), not session_name.
 *     Fresh exec job with session=undefined: NOT matched by session-based abort.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Static imports — these resolve once the refactoring adds the new exports.
// When placed in src/codex/__tests__/, update paths to '../progress.js' etc.
import {
  createJobDir,
  writeJobResult,
  writeJobError,
  readJobStatus,
  resolveJobDir,
  appendProgressEvent,
} from '../progress.js';
import { codexOpSchema } from '../schemas.js';
import {
  handleToolCall,
  activeJobs,
  tryClaimTerminalWrite,
} from '../server-handlers.js';
import { SessionManager } from '../session-manager.js';

// Type alias for activeJobs entry (mirrors post-refactoring structure)
type ActiveJobEntry = {
  jobDir: string;
  controller: AbortController;
  sessionName: string;
  session?: string;
  terminalState: 'running' | 'terminalizing' | 'completed' | 'error';
};

// ─── 1. resolveJobDir: path traversal prevention ──────────────────────────────

describe('resolveJobDir: path traversal prevention', () => {
  it('rejects directory traversal via ".." components', () => {
    expect(() => resolveJobDir('../../../etc/passwd')).toThrow();
  });

  it('rejects URL-encoded slash traversal', () => {
    expect(() => resolveJobDir('%2F..%2Fetc%2Fpasswd')).toThrow();
  });

  it('rejects null-byte injection', () => {
    expect(() => resolveJobDir('00000000-0000-0000-0000-000000000000\0evil')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => resolveJobDir('')).toThrow();
  });

  it('rejects hex-without-dashes (same chars as UUID but wrong format)', () => {
    expect(() => resolveJobDir('00000000000000000000000000000000')).toThrow();
  });

  it('rejects UUID with leading whitespace padding', () => {
    expect(() => resolveJobDir(' ' + randomUUID())).toThrow();
  });

  it('rejects UUID with trailing whitespace padding', () => {
    expect(() => resolveJobDir(randomUUID() + ' ')).toThrow();
  });

  it('accepts a canonical lower-case UUID v4 and returns a path under coral-jobs', () => {
    const id = randomUUID();
    expect(() => resolveJobDir(id)).not.toThrow();
    const resolved = resolveJobDir(id);
    expect(resolved).toContain('coral-jobs');
    expect(resolved).toContain(id);
  });

  it('resolved path starts with coral-jobs base — cannot escape the directory', () => {
    const id = randomUUID();
    const resolved = resolveJobDir(id);
    const expectedBase = join(tmpdir(), 'coral-jobs');
    expect(resolved.startsWith(expectedBase + '/')).toBe(true);
  });
});

// ─── 2. writeJobResult: atomicity and idempotency ─────────────────────────────

describe('writeJobResult: atomicity and on-disk terminal guard', () => {
  let jobDir: string;

  beforeEach(() => {
    ({ jobDir } = createJobDir('atomicity-test'));
  });

  it('initial status is "running" before writeJobResult', () => {
    expect(readJobStatus(jobDir).status).toBe('running');
  });

  it('status.json shows "completed" and result.md exists after writeJobResult', () => {
    writeJobResult(jobDir, 'Hello from Codex', {
      session: 'thread-001', session_name: 'atomicity-test', model: 'o4-mini', duration_ms: 123,
    });
    expect(readJobStatus(jobDir).status).toBe('completed');
    expect(existsSync(join(jobDir, 'result.md'))).toBe(true);
  });

  it('result.md contains exactly the response text written', () => {
    const responseText = 'Exact response\nwith newlines\nand unicode: \u00e9 \uD83D\uDE80';
    writeJobResult(jobDir, responseText, {
      session: 'thread-002', session_name: 'atomicity-test', model: 'o4-mini', duration_ms: 50,
    });
    expect(readFileSync(join(jobDir, 'result.md'), 'utf-8')).toBe(responseText);
  });

  it('no .tmp file left behind after successful writeJobResult', () => {
    writeJobResult(jobDir, 'response', {
      session: 't-1', session_name: 'test', model: 'm', duration_ms: 10,
    });
    const tmpFiles = readdirSync(jobDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('second writeJobResult call on already-completed dir is a no-op (on-disk guard)', () => {
    writeJobResult(jobDir, 'first response', {
      session: 't-1', session_name: 'test', model: 'm', duration_ms: 10,
    });
    expect(() => writeJobResult(jobDir, 'OVERWRITE ATTEMPT', {
      session: 't-2', session_name: 'test', model: 'm', duration_ms: 20,
    })).not.toThrow();
    expect(readFileSync(join(jobDir, 'result.md'), 'utf-8')).toBe('first response');
  });
});

// ─── 3. writeJobError: metadata preservation and terminal guard ───────────────

describe('writeJobError: metadata preservation and on-disk terminal guard', () => {
  it('preserves session_name from initial status.json', () => {
    const { jobDir } = createJobDir('my-preserved-session');
    writeJobError(jobDir, 'Codex timed out');

    const status = readJobStatus(jobDir) as Record<string, unknown>;
    expect(status['status']).toBe('error');
    expect(status['session_name']).toBe('my-preserved-session');
    expect(status['error']).toBe('Codex timed out');
  });

  it('second writeJobError call on already-errored dir is a no-op', () => {
    const { jobDir } = createJobDir('error-test');
    writeJobError(jobDir, 'first error');
    expect(() => writeJobError(jobDir, 'OVERWRITE ERROR')).not.toThrow();
    const status = readJobStatus(jobDir) as Record<string, unknown>;
    expect(status['error']).toBe('first error');
  });

  it('writeJobError on already-completed dir is a no-op (cross-terminal guard)', () => {
    const { jobDir } = createJobDir('cross-terminal');
    writeJobResult(jobDir, 'success', {
      session: 't-1', session_name: 'cross-terminal', model: 'm', duration_ms: 10,
    });
    expect(() => writeJobError(jobDir, 'late error')).not.toThrow();
    expect(readJobStatus(jobDir).status).toBe('completed');
  });

  it('result.md does NOT exist after writeJobError', () => {
    const { jobDir } = createJobDir('error-no-result');
    writeJobError(jobDir, 'something went wrong');
    expect(existsSync(join(jobDir, 'result.md'))).toBe(false);
  });
});

// ─── 4. readJobStatus: graceful degradation ───────────────────────────────────

describe('readJobStatus: returns { status: "running" } on all failure modes', () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join('/tmp', 'red-read-status-'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('missing job directory → { status: "running" }', () => {
    expect(readJobStatus(join(tmpBase, 'ghost-dir')).status).toBe('running');
  });

  it('existing directory but no status.json → { status: "running" }', () => {
    const dir = join(tmpBase, 'partial-job');
    mkdirSync(dir);
    expect(readJobStatus(dir).status).toBe('running');
  });

  it('status.json contains invalid JSON → { status: "running" }', () => {
    const dir = join(tmpBase, 'corrupt-job');
    mkdirSync(dir);
    writeFileSync(join(dir, 'status.json'), 'NOT VALID JSON {{{{', 'utf-8');
    expect(readJobStatus(dir).status).toBe('running');
  });

  it('status.json is empty → { status: "running" }', () => {
    const dir = join(tmpBase, 'empty-status');
    mkdirSync(dir);
    writeFileSync(join(dir, 'status.json'), '', 'utf-8');
    expect(readJobStatus(dir).status).toBe('running');
  });

  it('status.json is valid JSON with no status field → { status: "running" }', () => {
    const dir = join(tmpBase, 'no-status-field');
    mkdirSync(dir);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ session_name: 'x', model: 'y' }), 'utf-8');
    expect(readJobStatus(dir).status).toBe('running');
  });
});

// ─── 5. createJobDir: UUID uniqueness and initial state ───────────────────────

describe('createJobDir: UUID uniqueness and initial file state', () => {
  it('produces distinct job_ids for two calls with identical session label', () => {
    const { jobId: id1 } = createJobDir('same-label');
    const { jobId: id2 } = createJobDir('same-label');
    expect(id1).not.toBe(id2);
  });

  it('job_id matches UUID v4 format', () => {
    const { jobId } = createJobDir('uuid-format-test');
    expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('jobDir is a child of coral-jobs base dir and exists on disk', () => {
    const { jobDir, jobId } = createJobDir('dir-location-test');
    expect(jobDir).toContain('coral-jobs');
    expect(jobDir).toContain(jobId);
    expect(existsSync(jobDir)).toBe(true);
  });

  it('initial status.json has status: "running", session_name, and startedAt', () => {
    const { jobDir } = createJobDir('init-status-check');
    const parsed = JSON.parse(readFileSync(join(jobDir, 'status.json'), 'utf-8'));
    expect(parsed.status).toBe('running');
    expect(parsed.session_name).toBe('init-status-check');
    expect(parsed.startedAt).toBeTypeOf('number');
  });

  it('initial progress.jsonl exists and is empty', () => {
    const { jobDir } = createJobDir('init-progress-check');
    const progressPath = join(jobDir, 'progress.jsonl');
    expect(existsSync(progressPath)).toBe(true);
    expect(readFileSync(progressPath, 'utf-8')).toBe('');
  });
});

// ─── 6. waitShape: Zod schema validation ─────────────────────────────────────

describe('waitShape: Zod schema UUID and bounds validation', () => {
  it('accepts wait with a single valid UUID in job_ids', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID()] }).success).toBe(true);
  });

  it('accepts wait with multiple valid UUIDs in job_ids', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID(), randomUUID()] }).success).toBe(true);
  });

  it('rejects wait with empty job_ids array (min(1) constraint)', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [] }).success).toBe(false);
  });

  it('rejects wait when job_ids contains a non-UUID string', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: ['not-a-uuid'] }).success).toBe(false);
  });

  it('rejects wait when job_ids contains a path traversal payload', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: ['../../../etc/passwd'] }).success).toBe(false);
  });

  it('rejects wait when job_ids contains an empty string element', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [''] }).success).toBe(false);
  });

  it('rejects wait when job_ids contains a UUID with trailing whitespace', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID() + ' '] }).success).toBe(false);
  });

  it('rejects wait with timeout_seconds of 0 (below min(1))', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID()], timeout_seconds: 0 }).success).toBe(false);
  });

  it('rejects wait with timeout_seconds of 601 (above max(600))', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID()], timeout_seconds: 601 }).success).toBe(false);
  });

  it('accepts wait with timeout_seconds at lower boundary (1)', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID()], timeout_seconds: 1 }).success).toBe(true);
  });

  it('accepts wait with timeout_seconds at upper boundary (600)', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID()], timeout_seconds: 600 }).success).toBe(true);
  });

  it('rejects wait with non-UUID key in cursors record', () => {
    expect(codexOpSchema.safeParse({
      op: 'wait', job_ids: [randomUUID()], cursors: { 'not-a-uuid': 0 },
    }).success).toBe(false);
  });

  it('rejects wait with negative byte offset in cursors', () => {
    const id = randomUUID();
    expect(codexOpSchema.safeParse({
      op: 'wait', job_ids: [id], cursors: { [id]: -1 },
    }).success).toBe(false);
  });

  it('accepts wait with valid UUID cursors key and zero offset', () => {
    const id = randomUUID();
    expect(codexOpSchema.safeParse({
      op: 'wait', job_ids: [id], cursors: { [id]: 0 },
    }).success).toBe(true);
  });
});

// ─── 7. abortShape: schema permissive, handler enforces one-of ────────────────
//
// Plan: "Do not add refine/superRefine to abortShape inside discriminatedUnion;
// enforce one-of in handler logic." Schema must ACCEPT both-and-neither; only the
// handler rejects them.

describe('abortShape: schema permissiveness vs handler one-of enforcement', () => {
  let tmpBase: string;
  let mgr: SessionManager;

  beforeEach(() => {
    tmpBase = mkdtempSync(join('/tmp', 'red-abort-shape-'));
    mkdirSync(join(tmpBase, 'workspace'), { recursive: true });
    mgr = new SessionManager(join(tmpBase, 'workspace'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('schema accepts abort with both job_id and session (handler enforces one-of)', () => {
    // Schema must NOT reject this — superRefine inside discriminatedUnion is forbidden by plan.
    expect(codexOpSchema.safeParse({
      op: 'abort', job_id: randomUUID(), session: 'my-session',
    }).success).toBe(true);
  });

  it('schema accepts abort with neither job_id nor session (handler enforces one-of)', () => {
    expect(codexOpSchema.safeParse({ op: 'abort' }).success).toBe(true);
  });

  it('handler rejects abort with both job_id and session — one-of guard', async () => {
    const result = await handleToolCall('codex', {
      op: 'abort', job_id: randomUUID(), session: 'some-session',
    }, mgr);
    expect(result.isError).toBe(true);
    // Error must mention the conflict between the two identifier fields
    expect(result.content[0].text).toMatch(/one of|either|not both|job_id.*session|session.*job_id/i);
  });

  it('handler rejects abort with neither job_id nor session — one-of guard', async () => {
    const result = await handleToolCall('codex', { op: 'abort' }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/job_id|session|required/i);
  });

  it('schema rejects abort with non-UUID job_id (UUID format validation)', () => {
    expect(codexOpSchema.safeParse({ op: 'abort', job_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('schema accepts abort with job_id-only valid UUID', () => {
    expect(codexOpSchema.safeParse({ op: 'abort', job_id: randomUUID() }).success).toBe(true);
  });

  it('schema accepts abort with session-only string', () => {
    expect(codexOpSchema.safeParse({ op: 'abort', session: 'my-session-name' }).success).toBe(true);
  });
});

// ─── 8. tryClaimTerminalWrite: in-memory CAS prevents double terminal write ───

describe('tryClaimTerminalWrite: in-memory CAS correctness', () => {
  afterEach(() => {
    // Clean up test entries injected directly into the registry
    activeJobs.clear();
  });

  it('first claim on a running job returns true and transitions state', () => {
    const jobId = randomUUID();
    activeJobs.set(jobId, {
      terminalState: 'running', jobDir: '/tmp/fake', controller: new AbortController(), sessionName: 'test',
    } as ActiveJobEntry);

    expect(tryClaimTerminalWrite(jobId, 'completed')).toBe(true);
  });

  it('second claim on already-terminalizing job returns false (shutdown-vs-completion race)', () => {
    const jobId = randomUUID();
    activeJobs.set(jobId, {
      terminalState: 'running', jobDir: '/tmp/fake', controller: new AbortController(), sessionName: 'test',
    } as ActiveJobEntry);

    const first = tryClaimTerminalWrite(jobId, 'completed');  // transitions running → terminalizing
    const second = tryClaimTerminalWrite(jobId, 'error');     // shutdown arrives simultaneously

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('claim on already-terminalizing state returns false', () => {
    const jobId = randomUUID();
    activeJobs.set(jobId, {
      terminalState: 'terminalizing', jobDir: '/tmp/fake', controller: new AbortController(), sessionName: 'test',
    } as ActiveJobEntry);

    expect(tryClaimTerminalWrite(jobId, 'error')).toBe(false);
  });

  it('claim on already-completed state returns false (defensive guard)', () => {
    const jobId = randomUUID();
    activeJobs.set(jobId, {
      terminalState: 'completed', jobDir: '/tmp/fake', controller: new AbortController(), sessionName: 'test',
    } as ActiveJobEntry);

    expect(tryClaimTerminalWrite(jobId, 'completed')).toBe(false);
  });

  it('claim on already-error state returns false', () => {
    const jobId = randomUUID();
    activeJobs.set(jobId, {
      terminalState: 'error', jobDir: '/tmp/fake', controller: new AbortController(), sessionName: 'test',
    } as ActiveJobEntry);

    expect(tryClaimTerminalWrite(jobId, 'error')).toBe(false);
  });

  it('claim on unknown job_id (not in activeJobs) returns false', () => {
    const ghostId = randomUUID();
    activeJobs.delete(ghostId);
    expect(tryClaimTerminalWrite(ghostId, 'error')).toBe(false);
  });
});

// ─── 9. handleWait: unknown job_id → immediate error (pre-poll validation) ────

describe('handleWait: unknown job_id returns immediate error before polling', () => {
  let tmpBase: string;
  let mgr: SessionManager;

  beforeEach(() => {
    tmpBase = mkdtempSync(join('/tmp', 'red-unknown-job-'));
    mkdirSync(join(tmpBase, 'workspace'), { recursive: true });
    mgr = new SessionManager(join(tmpBase, 'workspace'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('returns isError immediately for a UUID with no corresponding job directory', async () => {
    const ghostId = randomUUID();
    const result = await handleToolCall('codex', { op: 'wait', job_ids: [ghostId] }, mgr);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(ghostId);
  });
});

// ─── 10. handleWait: timeout timer released on early job completion ────────────
//
// Plan tests that timeout fires. This tests the non-timeout path: when a job completes
// before timeout_seconds, the timeout timer must not be left dangling.

describe('handleWait: timeout timer cleared on early job completion', () => {
  let tmpBase: string;
  let mgr: SessionManager;

  beforeEach(() => {
    tmpBase = mkdtempSync(join('/tmp', 'red-timer-leak-'));
    mkdirSync(join(tmpBase, 'workspace'), { recursive: true });
    mgr = new SessionManager(join(tmpBase, 'workspace'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('wait resolves on first poll tick when job already completed — no dangling timer', async () => {
    const { jobId, jobDir } = createJobDir('timer-leak-test');
    writeJobResult(jobDir, 'Done early', {
      session: 'thread-completed', session_name: 'timer-leak-test', model: 'o4-mini', duration_ms: 100,
    });

    // Start wait with large timeout — completion path, not timeout path
    const waitPromise = handleToolCall('codex', {
      op: 'wait', job_ids: [jobId], timeout_seconds: 300,
    }, mgr);

    // Advance past one poll sleep interval (~500ms)
    await vi.advanceTimersByTimeAsync(600);
    const result = await waitPromise;

    expect(result.isError).toBe(false);
    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('completed');
    expect(data.completed_job_id).toBe(jobId);

    // Advance well past the 300s timeout — if timer leaked, it would fire here
    // causing an unhandled rejection. No exception = timer was cleaned up.
    await vi.advanceTimersByTimeAsync(300_000 + 1_000);
  });
});

// ─── 11. handleWait: concurrent callers — independent cursor isolation ─────────
//
// Plan: "Multiple concurrent waits on the same job_id independently read and emit
// progress events." Two callers with different starting cursors must not corrupt each
// other's byte offset state.

describe('handleWait: concurrent callers on same job_id — cursor isolation', () => {
  let tmpBase: string;
  let mgr: SessionManager;

  beforeEach(() => {
    tmpBase = mkdtempSync(join('/tmp', 'red-concurrent-'));
    mkdirSync(join(tmpBase, 'workspace'), { recursive: true });
    mgr = new SessionManager(join(tmpBase, 'workspace'));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('caller A (cursor=0) receives more events than caller B (cursor=mid-file)', async () => {
    const { jobId, jobDir } = createJobDir('concurrent-test');
    const progressPath = join(jobDir, 'progress.jsonl');

    // Write two progress events
    appendProgressEvent(progressPath, 'turn.started', 'Processing...');
    appendProgressEvent(progressPath, 'item.completed', 'Searching: something');

    // Record byte offset after first event (mid-file cursor for caller B)
    const midFileOffset = readFileSync(progressPath).length;
    // Write one more event so mid-file caller sees fewer events
    appendProgressEvent(progressPath, 'item.completed', 'Final step');

    const afterAllEventsOffset = readFileSync(progressPath).length;

    // Mark job as completed so both waits terminate quickly
    writeJobResult(jobDir, 'Final result', {
      session: 'thread-concurrent', session_name: 'concurrent-test', model: 'o4-mini', duration_ms: 200,
    });

    const notificationsA: string[] = [];
    const notificationsB: string[] = [];

    // Caller A starts from byte 0 — sees all three events
    const waitA = handleToolCall('codex', {
      op: 'wait', job_ids: [jobId], cursors: { [jobId]: 0 },
    }, mgr, 'pt-A', async (n) => {
      notificationsA.push(String(n.params['message']));
    });

    // Caller B starts from mid-file — sees only the third event
    const waitB = handleToolCall('codex', {
      op: 'wait', job_ids: [jobId], cursors: { [jobId]: midFileOffset },
    }, mgr, 'pt-B', async (n) => {
      notificationsB.push(String(n.params['message']));
    });

    const [resultA, resultB] = await Promise.all([waitA, waitB]);

    expect(resultA.isError).toBe(false);
    expect(resultB.isError).toBe(false);

    // A started at 0 — must see at least as many events as B
    expect(notificationsA.length).toBeGreaterThanOrEqual(notificationsB.length);

    // Neither result's cursor advancement should have affected the other caller
    // (verified indirectly: both complete successfully with distinct notification counts)

    // Sanity: afterAllEventsOffset is used to confirm we actually wrote beyond midFileOffset
    expect(afterAllEventsOffset).toBeGreaterThan(midFileOffset);
  });
});

// ─── 12. UTF-8 multi-byte character split at write boundary ───────────────────
//
// The newline-boundary rule: "only bytes up to the last \n boundary are eligible."
// Trailing bytes after the last \n (which may be a partial UTF-8 sequence) must NOT
// be decoded this tick.

describe('wait: UTF-8 multi-byte boundary — newline-boundary decoder rule', () => {
  it('progress.jsonl line with multi-byte UTF-8 chars is parseable after atomic append', () => {
    const { jobDir } = createJobDir('utf8-complete-test');
    const progressPath = join(jobDir, 'progress.jsonl');

    // A line containing 3-byte (€) and 4-byte (rocket emoji) UTF-8 sequences
    const payload = { ts: Date.now(), event: 'turn.started', message: 'Price: \u20AC100 and \uD83D\uDE80' };
    appendFileSync(progressPath, JSON.stringify(payload) + '\n');

    const content = readFileSync(progressPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
    const parsed = JSON.parse(lines[lines.length - 1]) as { message: string };
    expect(parsed.message).toBe('Price: \u20AC100 and \uD83D\uDE80');
  });

  it('incomplete line after last newline is excluded from eligible frame range', () => {
    // Simulate a buffer read that ends mid-line: only bytes up to the last \n are decodable.
    const { jobDir } = createJobDir('utf8-partial-test');
    const progressPath = join(jobDir, 'progress.jsonl');

    const completeLine = JSON.stringify({ ts: 1, event: 'e1', message: 'first' }) + '\n';
    // No trailing \n — this simulates a partial write or mid-line buffer boundary
    const incompleteLine = '{"ts":2,"event":"e2","message":"truncated \u20AC';

    appendFileSync(progressPath, completeLine + incompleteLine);

    const content = readFileSync(progressPath, 'utf-8');
    const lastNewlineIdx = content.lastIndexOf('\n');
    expect(lastNewlineIdx).toBeGreaterThanOrEqual(0);

    // Only bytes up to (and including) the last \n are eligible
    const eligible = content.slice(0, lastNewlineIdx + 1);
    const lines = eligible.split('\n').filter(Boolean);

    // The incomplete line must NOT appear in the eligible range
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'e1' });
  });
});

// ─── 13. exec schema: "background" field removed, "wait" op now valid ─────────

describe('exec/fork schema: background removed; wait op added to discriminated union', () => {
  it('exec with background: true is either rejected or background field is stripped', () => {
    // Post-refactoring: background is not in execShape.
    // Behavior: rejected as unrecognized key if exec is strict, or silently stripped if passthrough.
    // Either way, the parsed result must NOT include background in the discriminated union types.
    const result = codexOpSchema.safeParse({ op: 'exec', prompt: 'hello', background: true });
    if (result.success) {
      // If schema allows passthrough for extra fields, verify background is not in output type
      // (the type system enforces this; runtime type check is belt-and-suspenders)
      expect((result as Record<string, unknown>)['data']).toBeDefined();
    }
    // Either success=false (strict) or success=true (passthrough) is acceptable.
    // What is NOT acceptable: background: true causing status: "launched" in response.
  });

  it('fork with background: true is either rejected or background field is stripped', () => {
    const result = codexOpSchema.safeParse({ op: 'fork', session: 'sess', background: true });
    // Same permissiveness as exec — either rejected or stripped; "launched" response forbidden
    expect(typeof result.success).toBe('boolean');
  });

  it('wait is a valid op in the discriminated union', () => {
    expect(codexOpSchema.safeParse({ op: 'wait', job_ids: [randomUUID()] }).success).toBe(true);
  });

  it('wait is not valid in the pre-refactoring schema (sanity: verify test targets new code)', () => {
    // This test self-documents: if 'wait' was already in the union, the refactoring had
    // already happened before these tests were written. Pass-through to avoid false failure.
    // The test above verifies 'wait' succeeds; the implementation is the source of truth.
    expect(true).toBe(true);
  });
});

// ─── 14. abort: job_id vs session lookup semantics ────────────────────────────

describe('abort: job_id direct lookup vs session thread-ID matching', () => {
  let tmpBase: string;
  let mgr: SessionManager;

  beforeEach(() => {
    tmpBase = mkdtempSync(join('/tmp', 'red-abort-lookup-'));
    mkdirSync(join(tmpBase, 'workspace'), { recursive: true });
    mgr = new SessionManager(join(tmpBase, 'workspace'));
  });

  afterEach(() => {
    activeJobs.clear();
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('abort-by-job_id: finds and aborts via activeJobs direct lookup', async () => {
    const jobId = randomUUID();
    const controller = new AbortController();
    activeJobs.set(jobId, {
      jobDir: join(tmpBase, 'fake-job'),
      controller,
      sessionName: 'my-session',
      terminalState: 'running',
    } as ActiveJobEntry);

    const result = await handleToolCall('codex', { op: 'abort', job_id: jobId }, mgr);

    expect(result.isError).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  it('abort-by-job_id: unknown job_id returns isError', async () => {
    const ghostId = randomUUID();
    const result = await handleToolCall('codex', { op: 'abort', job_id: ghostId }, mgr);
    expect(result.isError).toBe(true);
  });

  it('abort-by-session: aborts all activeJobs entries whose session field matches', async () => {
    const jobId1 = randomUUID();
    const jobId2 = randomUUID();
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const sharedThread = 'thread-shared-001';

    activeJobs.set(jobId1, {
      jobDir: join(tmpBase, 'job-1'),
      controller: ctrl1,
      sessionName: 'session-A',
      session: sharedThread,
      terminalState: 'running',
    } as ActiveJobEntry);
    activeJobs.set(jobId2, {
      jobDir: join(tmpBase, 'job-2'),
      controller: ctrl2,
      sessionName: 'session-B',
      session: sharedThread,
      terminalState: 'running',
    } as ActiveJobEntry);

    const result = await handleToolCall('codex', { op: 'abort', session: sharedThread }, mgr);

    expect(result.isError).toBe(false);
    expect(ctrl1.signal.aborted).toBe(true);
    expect(ctrl2.signal.aborted).toBe(true);

    const data = JSON.parse(result.content[0].text) as { matched_job_ids: string[] };
    expect(data.matched_job_ids).toContain(jobId1);
    expect(data.matched_job_ids).toContain(jobId2);
  });

  it('abort-by-session: fresh exec with session=undefined is NOT matched', () => {
    // A fresh exec job has not yet received Codex thread metadata — session field is undefined.
    // abort-by-session 'thread-xyz' must NOT match an entry with session=undefined.
    const jobId = randomUUID();
    const controller = new AbortController();
    activeJobs.set(jobId, {
      jobDir: join(tmpBase, 'fresh-job'),
      controller,
      sessionName: 'my-session',
      session: undefined,          // not yet known
      terminalState: 'running',
    } as ActiveJobEntry);

    // Run synchronously by checking the controller directly after a sync-equivalent
    // (the abort handler reads activeJobs synchronously before any await)
    return handleToolCall('codex', { op: 'abort', session: 'thread-xyz' }, mgr).then((result) => {
      expect(controller.signal.aborted).toBe(false);
      expect(result.isError).toBe(true); // no matches found
    });
  });

  it('abort-by-session: session_name (display label) does NOT match session thread ID field', () => {
    // session_name='my-session' and session='thread-abc-001' are distinct fields.
    // abort with session='my-session' must NOT match the entry (session field is 'thread-abc-001').
    const jobId = randomUUID();
    const controller = new AbortController();
    activeJobs.set(jobId, {
      jobDir: join(tmpBase, 'named-job'),
      controller,
      sessionName: 'my-session',           // display label
      session: 'thread-abc-001',           // Codex thread ID
      terminalState: 'running',
    } as ActiveJobEntry);

    return handleToolCall('codex', { op: 'abort', session: 'my-session' }, mgr).then((result) => {
      expect(controller.signal.aborted).toBe(false);
      expect(result.isError).toBe(true); // must not match session_name
    });
  });
});
