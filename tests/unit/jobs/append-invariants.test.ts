import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { jobsRegistry } from '#src/jobs/events/index.js';
import type { JobLaunchRequestBody } from '#src/jobs/launch.js';
import { appendEvents } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcasters.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const NOW = new Date('2026-04-19T00:00:00.000Z');

const storageAdapter = {
  readdirSync: (path: string, opts: { withFileTypes: true }) => fs.readdirSync(path, opts),
  readFileSync: (path: string, enc: 'utf-8') => fs.readFileSync(path, enc),
};

function createDb(): Database.Database {
  const db = new Database(':memory:');
  applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
  return db;
}

function appendJobEvents(db: Database.Database, inputs: readonly CoralEventInput[]) {
  return appendEvents(db, inputs, {
    now: () => NOW,
    reducers: composeReducers(jobsRegistry),
    upcasters: createDefaultUpcasterRegistry(),
  });
}

function launchBody(jobId: string): JobLaunchRequestBody {
  return {
    sessionId: `session-${jobId}`,
    provider: 'codex',
    providerAction: 'exec',
    projectRoot: `/workspace/${jobId}`,
    coordinatorNamespace: 'tests',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    request: {
      prompt: `prompt for ${jobId}`,
      cwd: `/workspace/${jobId}`,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW.toISOString(),
  };
}

function launchInput(jobId: string): CoralEventInput<JobLaunchRequestBody> {
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId: `session-${jobId}` },
    bodyVersion: 1,
    body: launchBody(jobId),
  };
}

function terminalInput(jobId: string, content = 'done'): CoralEventInput {
  return {
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId: `session-${jobId}` },
    bodyVersion: 1,
    body: {
      terminal: {
        outcome: { kind: 'completed' },
        durationMs: 1,
        content,
      },
    },
  };
}

function progressInput(jobId: string): CoralEventInput {
  return {
    type: 'job.progress.emitted',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId: `session-${jobId}` },
    bodyVersion: 1,
    body: {
      kind: 'message',
      message: 'late progress',
    },
  };
}

function expectTerminalOrderViolation(run: () => unknown, jobId: string, type: string): void {
  expect(run).toThrowError(
    expect.objectContaining({
      code: 'job_terminal_order_violation',
      context: expect.objectContaining({ jobId, type }),
    }),
  );
}

describe('jobs append invariants', () => {
  it('rejects duplicate terminal events through raw appendEvents', () => {
    const db = createDb();
    try {
      const jobId = 'job-duplicate-terminal';
      appendJobEvents(db, [launchInput(jobId), terminalInput(jobId)]);

      expectTerminalOrderViolation(() => appendJobEvents(db, [terminalInput(jobId, 'again')]), jobId, 'job.terminal.recorded');
    } finally {
      db.close();
    }
  });

  it('rejects job events after terminal in the same raw append batch', () => {
    const db = createDb();
    try {
      const jobId = 'job-terminal-not-last';

      expectTerminalOrderViolation(
        () => appendJobEvents(db, [launchInput(jobId), terminalInput(jobId), progressInput(jobId)]),
        jobId,
        'job.progress.emitted',
      );
      expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
  });

  it('rejects progress after an existing terminal event', () => {
    const db = createDb();
    try {
      const jobId = 'job-late-progress';
      appendJobEvents(db, [launchInput(jobId), terminalInput(jobId)]);

      expectTerminalOrderViolation(() => appendJobEvents(db, [progressInput(jobId)]), jobId, 'job.progress.emitted');
    } finally {
      db.close();
    }
  });

  it('allows launch rejection to be followed by the terminal outcome', () => {
    const db = createDb();
    try {
      const jobId = 'job-rejected-terminal';
      appendJobEvents(db, [launchInput(jobId)]);
      const [rejected] = appendJobEvents(db, [
        {
          type: 'job.launch.rejected',
          stream: { kind: 'job', id: jobId },
          refs: { jobId, sessionId: `session-${jobId}` },
          bodyVersion: 1,
          body: {
            reason: 'busy',
            message: 'busy',
            provider: 'codex',
            globalActive: 1,
            globalLimit: 1,
          },
        },
      ]);

      const [terminal] = appendJobEvents(db, [
        {
          type: 'job.terminal.recorded',
          stream: { kind: 'job', id: jobId },
          refs: { jobId, sessionId: `session-${jobId}` },
          bodyVersion: 1,
          body: {
            terminal: {
              outcome: {
                kind: 'failed',
                causeRef: {
                  stream: { kind: 'job', id: jobId },
                  seq: rejected.seq,
                },
              },
              durationMs: 1,
              content: 'failed',
            },
          },
        },
      ]);

      expect(terminal.seq).toBeGreaterThan(rejected.seq);
    } finally {
      db.close();
    }
  });

  it('allows an abort event to be followed by the terminal outcome', () => {
    const db = createDb();
    try {
      const jobId = 'job-aborted-terminal';
      appendJobEvents(db, [launchInput(jobId)]);
      const [aborted] = appendJobEvents(db, [
        {
          type: 'job.aborted',
          stream: { kind: 'job', id: jobId },
          refs: { jobId, sessionId: `session-${jobId}` },
          bodyVersion: 1,
          body: { reason: 'user_abort' },
        },
      ]);

      const [terminal] = appendJobEvents(db, [
        {
          type: 'job.terminal.recorded',
          stream: { kind: 'job', id: jobId },
          refs: { jobId, sessionId: `session-${jobId}` },
          bodyVersion: 1,
          body: {
            terminal: {
              outcome: { kind: 'aborted', reason: 'user_abort' },
              durationMs: 1,
              content: '',
            },
          },
        },
      ]);

      expect(terminal.seq).toBeGreaterThan(aborted.seq);
    } finally {
      db.close();
    }
  });
});
