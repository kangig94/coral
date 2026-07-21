import type { Database } from '#src/store/db.js';
import type { AppendedEvent } from '#src/store/append.js';
import type { JobTerminalEvent } from '#src/jobs/records.js';
import type { UsageSummary } from '#src/providers/contract.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { composeReducers } from '#src/store/reducers.js';
import { jobsRegistry } from '#src/jobs/events.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { createDefaultStoreReadContext } from '#src/read-model/read-context.js';
import { readJobEvents } from '#src/jobs/read-queries.js';
import { publishJobEvents, subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';
import { parseWaitStreamEvent } from '#src/jobs/wait-stream-event.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { describe, expect, it } from 'vitest';

const usage = {
  inputTokens: 11,
  cacheReadTokens: 22,
  cacheWriteTokens: 3,
  outputTokens: 5,
  costUsd: 0.42,
} satisfies UsageSummary;

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db);
  return db;
}

function terminalBody(options: { usage?: UsageSummary } = {}) {
  return {
    terminal: {
      content: 'done',
      outcome: { kind: 'completed' },
      durationMs: 12,
    },
    ...(options.usage ? { diagnostics: { usage: options.usage } } : {}),
  };
}

function terminalAppendedEvent(jobId: string, options: { usage?: UsageSummary } = {}): AppendedEvent {
  return {
    seq: 1,
    ts: '2026-04-19T00:00:00.000Z',
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: jobId },
    namespace: 'wait-usage-ns',
    project: '/tmp/wait-usage-project',
    correlationId: 'wait-usage-correlation',
    refs: { sessionId: 'wait-usage-session' },
    bodyVersion: 1,
    body: terminalBody(options),
  };
}

function commitRecordedTerminal(db: Database, jobId: string, options: { usage?: UsageSummary } = {}): void {
  commitInputs(
    db,
    [
      {
        type: 'job.launch.requested',
        stream: { kind: 'job', id: jobId },
        namespace: 'wait-usage-ns',
        project: '/tmp/wait-usage-project',
        correlationId: 'wait-usage-correlation',
        refs: { sessionId: 'wait-usage-session' },
        bodyVersion: 1,
        body: {
          sessionId: 'wait-usage-session',
          provider: 'codex',
          providerAction: 'exec',
          projectRoot: '/tmp/wait-usage-project',
          backendNamespace: 'wait-usage-ns',
          bundleHash: 'wait-usage-bundle',
          jobKind: 'provider',
          pool: 'default',
          enqueueSequence: 0,
          request: {
            prompt: 'hello',
            cwd: '/tmp/wait-usage-project',
            bypassPermissions: false,
            coralEnv: {},
          },
          createdAt: '2026-04-19T00:00:00.000Z',
        },
      },
      {
        type: 'job.terminal.recorded',
        stream: { kind: 'job', id: jobId },
        namespace: 'wait-usage-ns',
        project: '/tmp/wait-usage-project',
        correlationId: 'wait-usage-correlation',
        refs: { sessionId: 'wait-usage-session' },
        bodyVersion: 1,
        body: terminalBody(options),
      },
    ],
    {
      now: () => new Date('2026-04-19T00:00:00.000Z'),
      reducers: composeReducers(jobsRegistry),
      upcasters: createDefaultUpcasterRegistry(),
      providers: permissiveProviderLookupPort,
    },
  );
}

function terminalEvent(events: readonly unknown[]): JobTerminalEvent {
  const event = events.find((candidate): candidate is JobTerminalEvent => {
    return typeof candidate === 'object' && candidate !== null && 'type' in candidate && candidate.type === 'terminal';
  });
  if (!event) {
    throw new Error('Expected terminal event');
  }
  return event;
}

describe('wait usage threading', () => {
  it('surfaces recorded terminal diagnostics usage through the live job event subscription', async () => {
    const jobId = 'wait-usage-live';
    const iterator = subscribeJobEvents({ afterSeq: 0, jobIds: [jobId] })[Symbol.asyncIterator]();
    const next = iterator.next();

    try {
      publishJobEvents([terminalAppendedEvent(jobId, { usage })]);

      const result = await next;
      expect(result.done).toBe(false);
      expect(result.value).toMatchObject({
        type: 'terminal',
        jobId,
        usage,
      });
    } finally {
      await iterator.return?.();
    }
  });

  it('leaves live terminal usage undefined when diagnostics usage is absent', async () => {
    const jobId = 'wait-usage-live-absent';
    const iterator = subscribeJobEvents({ afterSeq: 0, jobIds: [jobId] })[Symbol.asyncIterator]();
    const next = iterator.next();

    try {
      publishJobEvents([terminalAppendedEvent(jobId)]);

      const result = await next;
      expect(result.done).toBe(false);
      if (result.done || result.value.type !== 'terminal') {
        throw new Error('Expected terminal event');
      }
      expect(result.value.usage).toBeUndefined();
    } finally {
      await iterator.return?.();
    }
  });

  it('surfaces recorded terminal diagnostics usage through readJobEvents', () => {
    const db = createDb();
    try {
      const jobId = 'wait-usage-replay';
      commitRecordedTerminal(db, jobId, { usage });

      const event = terminalEvent(readJobEvents(db, jobId, createDefaultStoreReadContext()));
      expect(event.usage).toEqual(usage);
    } finally {
      db.close();
    }
  });

  it('leaves replay terminal usage undefined when diagnostics usage is absent', () => {
    const db = createDb();
    try {
      const jobId = 'wait-usage-replay-absent';
      commitRecordedTerminal(db, jobId);

      const event = terminalEvent(readJobEvents(db, jobId, createDefaultStoreReadContext()));
      expect(event.usage).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('parses wait terminal SSE payloads with optional usage', () => {
    const event = parseWaitStreamEvent(
      'terminal',
      JSON.stringify({
        type: 'terminal',
        jobId: 'wait-usage-sse',
        seq: 8,
        remainingJobIds: [],
        resultPath: '/tmp/result.md',
        result: {
          content: 'done',
          outcome: { kind: 'completed' },
          durationMs: 12,
        },
        continuity: null,
        usage,
      }),
    );

    expect(event).toMatchObject({
      type: 'terminal',
      jobId: 'wait-usage-sse',
      usage,
    });
    expect(
      parseWaitStreamEvent(
        'terminal',
        JSON.stringify({
          type: 'terminal',
          jobId: 'wait-usage-sse-absent',
          seq: 9,
          remainingJobIds: [],
          resultPath: '/tmp/result.md',
          result: {
            content: 'done',
            outcome: { kind: 'completed' },
            durationMs: 12,
          },
        }),
      ),
    ).toMatchObject({ type: 'terminal', jobId: 'wait-usage-sse-absent' });
  });
});
