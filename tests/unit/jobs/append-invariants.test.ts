import { currentCoralStoreFormat } from '#src/store-format.js';
import type { Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { jobsRegistry } from '#src/jobs/events.js';
import type { JobLaunchRequestBody } from '#src/jobs/launch.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { TEST_CODEX_SCOPE } from '#tests/helpers/provider-credentials.js';
import { commit } from '#src/store/append.js';
import type { CoralEventInput } from '#src/store/envelope.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { composeReducers } from '#src/store/reducers.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { seedTestSessionProjection } from '#tests/helpers/session.js';
import { workflowRegistry } from '#src/workflow/events.js';

const NOW = new Date('2026-04-19T00:00:00.000Z');

function createDb(): Database {
  const db = newRawDatabase(':memory:');
  applyBundledStoreSchema(db, currentCoralStoreFormat());
  return db;
}

function appendJobEvents(db: Database, inputs: readonly CoralEventInput[]) {
  return commitInputs(db, inputs, {
    now: () => NOW,
    reducers: composeReducers(jobsRegistry, workflowRegistry),
    bodyCodec: createEventBodyCodec(),
    providers: permissiveProviderLookupPort,
  });
}

function launchBody(jobId: string): Extract<JobLaunchRequestBody, { jobKind: 'provider' }> {
  return {
    owner: { kind: 'provider-session', id: `session-${jobId}` },
    sessionId: `session-${jobId}`,
    provider: 'codex',
    providerAction: 'exec',
    projectRoot: `/workspace/${jobId}`,
    backendNamespace: 'tests',
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
    body: launchBody(jobId),
  };
}

function terminalInput(jobId: string, content = 'done'): CoralEventInput {
  return {
    type: 'job.terminal.recorded',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId: `session-${jobId}` },
    body: {
      terminal: {
        outcome: { kind: 'completed' },
        durationMs: 1,
        content,
      },
    },
  };
}

function seedWorkflow(
  db: Database,
  workflowId: string,
  lifecycle: 'active' | 'draining' | 'faulted' | 'completed' | 'failed' | 'aborted' = 'active',
): void {
  const plan = {
    slots: [
      {
        slotId: `${workflowId}:0:0`,
        dependencies: [],
        provider: 'codex',
        instruction: 'test workflow child',
      },
    ],
  };
  db.prepare(
    `INSERT INTO projection_workflows (workflow_id, plan, provider_scope, lifecycle, last_seq)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(workflowId, JSON.stringify(plan), JSON.stringify(TEST_CODEX_SCOPE), lifecycle);
}

function workflowChildInput(options: {
  jobId: string;
  workflowId: string;
  slotId: string;
  sessionId: string;
  generation: number;
  replaces?: string;
}): CoralEventInput<JobLaunchRequestBody> {
  return {
    type: 'job.launch.requested',
    stream: { kind: 'job', id: options.jobId },
    refs: {
      jobId: options.jobId,
      sessionId: options.sessionId,
      parentJobId: options.workflowId,
      workflowId: options.workflowId,
      workflowSlotId: options.slotId,
    },
    body: {
      ...launchBody(options.jobId),
      owner: { kind: 'workflow', id: options.workflowId },
      sessionId: options.sessionId,
      projectRoot: '/workspace',
      request: { ...launchBody(options.jobId).request, cwd: '/workspace' },
      workflowSlotGeneration: options.generation,
      ...(options.replaces === undefined ? {} : { replacesWorkflowJobId: options.replaces }),
    },
  };
}

function progressInput(jobId: string): CoralEventInput {
  return {
    type: 'job.progress.emitted',
    stream: { kind: 'job', id: jobId },
    refs: { jobId, sessionId: `session-${jobId}` },
    body: {
      kind: 'message',
      message: 'late progress',
      timing: {
        origin: 'launch',
        originAt: NOW.toISOString(),
        emittedAt: '2026-04-19T00:00:01.000Z',
        elapsedMs: 1000,
      },
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
  it('requires a provider job to hold the current ProviderSession claim', () => {
    const db = createDb();
    try {
      const jobId = 'claimed-job';
      const input = launchInput(jobId);
      const launch = input.body as Extract<JobLaunchRequestBody, { jobKind: 'provider' }>;
      seedTestSessionProjection(db, {
        sessionId: launch.sessionId,
        provider: launch.provider,
        projectRoot: launch.projectRoot,
        backendNamespace: launch.backendNamespace,
        activeJobId: 'different-job',
      });

      expect(() =>
        commit(
          db,
          (c) => {
            c.append(input);
            return undefined;
          },
          {
            now: () => NOW,
            reducers: composeReducers(jobsRegistry, workflowRegistry),
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrowError(expect.objectContaining({ code: 'job_binding_owner_mismatch' }));
      expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it('requires provider job project and backend scope to equal its ProviderSession', () => {
    const db = createDb();
    try {
      const jobId = 'scope-mismatch-job';
      const input = launchInput(jobId);
      const launch = input.body as Extract<JobLaunchRequestBody, { jobKind: 'provider' }>;
      seedTestSessionProjection(db, {
        sessionId: launch.sessionId,
        provider: launch.provider,
        projectRoot: '/different-project',
        backendNamespace: launch.backendNamespace,
        activeJobId: jobId,
      });

      expect(() => appendJobEvents(db, [input])).toThrowError(
        expect.objectContaining({ code: 'job_binding_owner_mismatch' }),
      );
      expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each(['completed', 'failed', 'aborted'] as const)(
    'rejects workflow child launch when its owner lifecycle is %s',
    (lifecycle) => {
      const db = createDb();
      try {
        seedWorkflow(db, 'workflow-terminal', lifecycle);
        seedTestSessionProjection(db, {
          sessionId: 'session-child',
          provider: 'codex',
          projectRoot: '/workspace',
        });

        expect(() =>
          appendJobEvents(db, [
            workflowChildInput({
              jobId: 'child-after-terminal',
              workflowId: 'workflow-terminal',
              slotId: 'workflow-terminal:0:0',
              sessionId: 'session-child',
              generation: 0,
            }),
          ]),
        ).toThrowError(
          expect.objectContaining({
            code: 'workflow_owner_terminal',
            context: expect.objectContaining({
              workflowId: 'workflow-terminal',
              lifecycle,
              requestedJobId: 'child-after-terminal',
            }),
          }),
        );
      } finally {
        db.close();
      }
    },
  );

  it('rejects a workflow child launch fenced by a terminal lifecycle in the same commit', () => {
    const db = createDb();
    try {
      seedWorkflow(db, 'workflow-same-batch-terminal', 'active');
      seedTestSessionProjection(db, {
        sessionId: 'same-batch-terminal-session',
        provider: 'codex',
        projectRoot: '/workspace',
        activeJobId: 'same-batch-terminal-child',
      });
      const launch = workflowChildInput({
        jobId: 'same-batch-terminal-child',
        workflowId: 'workflow-same-batch-terminal',
        slotId: 'workflow-same-batch-terminal:0:0',
        sessionId: 'same-batch-terminal-session',
        generation: 0,
      });

      expect(() =>
        commitInputs(
          db,
          [
            launch,
            {
              type: 'workflow.completed',
              stream: { kind: 'workflow', id: 'workflow-same-batch-terminal' },
              refs: { workflowId: 'workflow-same-batch-terminal' },
              body: { outcome: 'completed', stepDetails: [] },
            },
          ],
          {
            now: () => NOW,
            reducers: composeReducers(jobsRegistry, workflowRegistry),
            bodyCodec: createEventBodyCodec(),
            providers: permissiveProviderLookupPort,
          },
        ),
      ).toThrowError(expect.objectContaining({ code: 'workflow_owner_terminal' }));
      expect((db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(0);
    } finally {
      db.close();
    }
  });

  it.each(['active', 'draining', 'faulted'] as const)(
    'allows workflow child launch while its owner lifecycle is %s',
    (lifecycle) => {
      const db = createDb();
      try {
        seedWorkflow(db, 'workflow-recoverable', lifecycle);
        seedTestSessionProjection(db, {
          sessionId: 'session-child',
          provider: 'codex',
          projectRoot: '/workspace',
        });

        expect(() =>
          appendJobEvents(db, [
            workflowChildInput({
              jobId: 'child-while-recoverable',
              workflowId: 'workflow-recoverable',
              slotId: 'workflow-recoverable:0:0',
              sessionId: 'session-child',
              generation: 0,
            }),
          ]),
        ).not.toThrow();
      } finally {
        db.close();
      }
    },
  );

  it('rejects a second current child for the same workflow slot', () => {
    const db = createDb();
    try {
      seedWorkflow(db, 'workflow-1');
      seedTestSessionProjection(db, {
        sessionId: 'session-child-0',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      seedTestSessionProjection(db, {
        sessionId: 'session-child-1',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      appendJobEvents(db, [
        workflowChildInput({
          jobId: 'child-0',
          workflowId: 'workflow-1',
          slotId: 'workflow-1:0:0',
          sessionId: 'session-child-0',
          generation: 0,
        }),
      ]);

      expect(() =>
        appendJobEvents(db, [
          workflowChildInput({
            jobId: 'child-1',
            workflowId: 'workflow-1',
            slotId: 'workflow-1:0:0',
            sessionId: 'session-child-1',
            generation: 1,
            replaces: 'child-0',
          }),
        ]),
      ).toThrowError(expect.objectContaining({ code: 'workflow_slot_chain_invalid' }));
    } finally {
      db.close();
    }
  });

  it('rejects a replacement generation that skips the terminal slot head', () => {
    const db = createDb();
    try {
      seedWorkflow(db, 'workflow-1');
      seedTestSessionProjection(db, {
        sessionId: 'session-child-0',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      seedTestSessionProjection(db, {
        sessionId: 'session-child-2',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      appendJobEvents(db, [
        workflowChildInput({
          jobId: 'child-0',
          workflowId: 'workflow-1',
          slotId: 'workflow-1:0:0',
          sessionId: 'session-child-0',
          generation: 0,
        }),
        terminalInput('child-0'),
      ]);

      expect(() =>
        appendJobEvents(db, [
          workflowChildInput({
            jobId: 'child-2',
            workflowId: 'workflow-1',
            slotId: 'workflow-1:0:0',
            sessionId: 'session-child-2',
            generation: 2,
            replaces: 'child-0',
          }),
        ]),
      ).toThrowError(expect.objectContaining({ code: 'workflow_slot_chain_invalid' }));
    } finally {
      db.close();
    }
  });

  it('rejects a replacement launch without the exact claimed continuation intent in the same commit', () => {
    const db = createDb();
    try {
      seedWorkflow(db, 'workflow-1');
      seedTestSessionProjection(db, {
        sessionId: 'session-child',
        provider: 'codex',
        projectRoot: '/workspace',
      });
      appendJobEvents(db, [
        workflowChildInput({
          jobId: 'child-0',
          workflowId: 'workflow-1',
          slotId: 'workflow-1:0:0',
          sessionId: 'session-child',
          generation: 0,
        }),
        terminalInput('child-0'),
      ]);

      expect(() =>
        appendJobEvents(db, [
          workflowChildInput({
            jobId: 'child-1',
            workflowId: 'workflow-1',
            slotId: 'workflow-1:0:0',
            sessionId: 'session-child',
            generation: 1,
            replaces: 'child-0',
          }),
        ]),
      ).toThrowError(
        expect.objectContaining({
          code: 'workflow_slot_chain_invalid',
          message: expect.stringContaining('claimed continuation intent'),
        }),
      );
    } finally {
      db.close();
    }
  });
  it('rejects duplicate terminal events through raw commitInputs', () => {
    const db = createDb();
    try {
      const jobId = 'job-duplicate-terminal';
      appendJobEvents(db, [launchInput(jobId), terminalInput(jobId)]);

      expectTerminalOrderViolation(
        () => appendJobEvents(db, [terminalInput(jobId, 'again')]),
        jobId,
        'job.terminal.recorded',
      );
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
          body: { reason: 'user_abort' },
        },
      ]);

      const [terminal] = appendJobEvents(db, [
        {
          type: 'job.terminal.recorded',
          stream: { kind: 'job', id: jobId },
          refs: { jobId, sessionId: `session-${jobId}` },
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
