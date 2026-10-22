import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobSendRequest } from '#src/coordinator/services/job-send.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import { appendJobExecutionOutcomeAccepted } from '#src/jobs/terminal/recording.js';
import { followJobs } from '#src/cli/follow.js';
import type { AcceptedProviderJobLaunchDecision } from '#src/jobs/launch.js';
import type { JobSendResult } from '#src/jobs/send.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});
const nextMessageId = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
function attempt(
  f: ReturnType<typeof conversationIdentityFixture>,
  previous: Pick<AcceptedProviderJobLaunchDecision, 'jobId' | 'requestedSeq' | 'epochKey'>,
  execution: number,
  input: string,
): JobSendRequest {
  return {
    projectRoot: f.ctx.projectRoot,
    jobId: previous.jobId,
    input,
    clientMessageId: nextMessageId(execution),
    target: { mode: 'continue', execution, requestedSeq: previous.requestedSeq, sourceEpoch: previous.epochKey },
  };
}
function launched(result: JobSendResult) {
  if (result.state !== 'launched') throw new Error(`Continuation was not launched: ${JSON.stringify(result)}`);
  return result.launch;
}
async function first(f: ReturnType<typeof conversationIdentityFixture>, provider = 'codex') {
  const decision = await f.drive(
    f.service.start(provider, { prompt: 'first', retention: 'discard_provider_artifacts_on_terminal' }, f.ctx),
  );
  if (decision.status !== 'running' && decision.status !== 'queued') throw new Error(decision.message);
  await f.drive(f.service.waitForJobTerminal(decision.jobId, 10_000));
  return decision;
}

describe('jobs send continuation through the execution owner', () => {
  it.each(['codex', 'claude'].flatMap((provider) => [false, true].map((agent) => ({ provider, agent }))))(
    'restores and resumes the $provider conversation with agent=$agent and its original facet',
    async ({ provider, agent }) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      const cwd = fixtureCanonicalWorkDir('/workspace/child');
      f.runtime.storage.mkdirSync(cwd, { recursive: true });
      f.runtime.storage.mkdirSync('/plugin/agents', { recursive: true });
      f.runtime.storage.writeFileSync(
        '/plugin/agents/architect.md',
        '---\nmodel: fixture-model\neffort: high\n---\nAgent instruction',
      );
      try {
        const initial = await f.drive(
          f.service.start(
            provider,
            {
              prompt: 'first',
              cwd,
              ...(agent
                ? { agent: 'architect' }
                : {
                    model: 'fixture-model',
                    instruction: { content: 'Raw instruction', channel: 'system' as const },
                    bypassPermissions: true,
                  }),
              retention: 'discard_provider_artifacts_on_terminal',
            },
            f.ctx,
          ),
        );
        if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        expect(f.runtime.storage.existsSync(f.nativePath(initial.jobId, provider))).toBe(false);
        const request = attempt(f, initial, 1, 'second');
        const second = launched(await f.drive(f.service.send(request, f.ctx)));
        expect(second).toMatchObject({ jobId: initial.jobId, epochKey: ':memory:' });
        expect(second.requestedSeq).toBeGreaterThan(initial.requestedSeq);
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        expect(f.restored).toEqual(['first\n']);
        expect(f.requests[1]).toMatchObject({
          action: 'resume',
          jobId: initial.jobId,
          conversationRef: `thread-${initial.jobId}`,
          prompt: 'second',
          cwd,
          model: f.requests[0].model,
          instruction: f.requests[0].instruction,
          bypassPermissions: f.requests[0].bypassPermissions,
        });
        expect(readProjectionJobConversation(f.db, initial.jobId)?.agent).toBe(agent ? 'architect' : undefined);
        expect(
          f
            .events(initial.jobId)
            .filter((event) => event.type === 'job.execution.requested')
            .map((event) => event.body),
        ).toEqual([
          expect.objectContaining({ execution: 1 }),
          expect.objectContaining({
            execution: 2,
            input: 'second',
            originatingClientMessageId: request.clientMessageId,
          }),
        ]);
        const before = f.events(initial.jobId);
        const restarted = f.restartCoordinator();
        expect(await f.drive(restarted.send(request, f.ctx))).toEqual({ state: 'launched', launch: second });
        expect(f.events(initial.jobId)).toEqual(before);
        expect(f.requests).toHaveLength(2);
        expect(f.restored).toHaveLength(1);
        expect(f.discarded).toHaveLength(2);
      } finally {
        await f.dispose();
      }
    },
  );

  it('rereads a committed request after losing its commit acknowledgement, then replays across restart', async () => {
    const f = conversationIdentityFixture({ managedArtifacts: true });
    try {
      const initial = await first(f);
      f.loseNextRequestCommitAcknowledgement();
      const request = attempt(f, initial, 1, 'second');
      const second = launched(await f.drive(f.service.send(request, f.ctx)));
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      const restarted = f.restartCoordinator();
      for (let n = 0; n < 2; n++)
        expect(await f.drive(restarted.send(request, f.ctx))).toEqual({ state: 'launched', launch: second });
      expect(f.requests.map((request) => request.prompt)).toEqual(['first', 'second']);
      expect(f.restored).toEqual(['first\n']);
      expect(f.discarded).toHaveLength(2);
      f.assertIdentity(initial.jobId, [1, 2]);
    } finally {
      await f.dispose();
    }
  });

  it('returns #2 after #3 is latest before the first subscription, through handover and reconnect', async () => {
    const f = conversationIdentityFixture({
      managedArtifacts: true,
      failOnResume: (request) => request.prompt === 'second result',
    });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, cb?: () => void) => {
      cb?.();
      return true;
    }) as typeof process.stdout.write);
    try {
      const initial = await first(f);
      const second = launched(await f.drive(f.service.send(attempt(f, initial, 1, 'second result'), f.ctx)));
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      const third = launched(await f.drive(f.service.send(attempt(f, second, 2, 'third result'), f.ctx)));
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      expect(third.requestedSeq).toBeGreaterThan(second.requestedSeq);
      expect(f.store.readTerminalProjection(initial.jobId)?.outcome).toEqual({ kind: 'completed' });
      const restarted = f.restartCoordinator();
      const requests: Array<{ executionSelections?: unknown }> = [];
      const emitError = vi.fn();
      const code = await f.drive(
        followJobs({
          start: { kind: 'launch', launchResult: second },
          projectRoot: f.ctx.projectRoot,
          reconnectPolicy: 'until-terminal',
          emitError,
          render: { isTTY: false, columns: 80, embed: true, verbose: false },
          connect: async (request) => {
            requests.push(request);
            if (requests.length === 1)
              return {
                kind: 'subscription',
                subscription: {
                  close: async () => {},
                  async *[Symbol.asyncIterator]() {
                    yield { type: 'handover' };
                  },
                },
              };
            const stream = restarted.waitStream({ ...request, jobIds: [...request.jobIds], timeoutSeconds: 1 });
            return {
              kind: 'subscription',
              subscription: {
                close: async () => {
                  await stream.return(undefined);
                },
                [Symbol.asyncIterator]: () => stream,
              },
            };
          },
        }),
      );
      expect(code).toBe(7);
      expect(emitError).not.toHaveBeenCalled();
      expect(requests).toHaveLength(2);
      for (const request of requests)
        expect(request.executionSelections).toEqual([
          {
            jobId: second.jobId,
            requestedSeq: second.requestedSeq,
            epochKey: second.epochKey,
            awaitingArtifact: false,
          },
        ]);
      const text = output.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(text).toContain('second result');
      expect(text).toContain(`/executions/2/result.md`);
      expect(text).not.toContain(`/executions/3/result.md`);
      expect(text).not.toContain('third result');
    } finally {
      await f.dispose();
    }
  });

  it('does not commit a bound continuation when another execution advances before the commit transaction', async () => {
    const f = conversationIdentityFixture({ managedArtifacts: true });
    try {
      const initial = await first(f);
      const request = attempt(f, initial, 1, 'loser');
      const originalAdmission = f.store.withExecutionAdmission.bind(f.store);
      let advanced = false;
      vi.spyOn(f.store, 'withExecutionAdmission').mockImplementation((jobId, execution, subject, action) => {
        if (execution === 2 && !advanced) {
          advanced = true;
          f.commit((c) => {
            c.append({
              type: 'job.execution.requested',
              stream: { kind: 'job', id: jobId },
              body: {
                execution: 2,
                action: 'resume',
                input: 'winner',
                pool: 'default',
                enqueueSequence: 2,
                coralEnv: {},
                createdAt: new Date(f.runtime.time.now()).toISOString(),
                backendNamespace: 'identity-test',
                originatingClientMessageId: nextMessageId(9),
              },
            });
            return undefined;
          });
        }
        originalAdmission(jobId, execution, subject, action);
      });
      expect(await f.drive(f.service.send(request, f.ctx))).toMatchObject({
        state: 'refused',
        code: 'continuation_target_changed',
      });
      expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
      expect(f.restored).toHaveLength(0);
      expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested')).toHaveLength(2);
      f.commit((c) => {
        appendJobExecutionOutcomeAccepted(c, {
          jobId: initial.jobId,
          execution: 2,
          terminal: { content: '', outcome: { kind: 'completed' }, durationMs: 0 },
        });
        return undefined;
      });
      await flushMicrotasks(100);
    } finally {
      await f.dispose();
    }
  });
});
