import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobSendRequest } from '#src/coordinator/services/job-send.js';
import { readProjectionJobConversation } from '#src/jobs/conversation/read-queries.js';
import { join } from 'node:path';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { executionKey } from '#src/jobs/execution-address.js';
import { listExecutionRetryStatuses, readExecutionRetryStatus } from '#src/jobs/finishing.js';
import { appendJobExecutionOutcomeAccepted, appendJobExecutionEnded } from '#src/jobs/terminal/recording.js';
import { requestedExecution, executionInput } from '#tests/helpers/job-executions.js';
import * as executionJournal from '#src/jobs/execution-journal.js';
import { conversationArchiveDirectory } from '#src/jobs/conversation/provider-artifact-archive.js';
import { followJobs } from '#src/cli/follow.js';
import type { AcceptedProviderJobLaunchDecision } from '#src/jobs/launch.js';
import type { JobSendResult } from '#src/jobs/send.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import * as workDirectories from '#src/runtime/canonical-work-dir.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
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
  it.each(['/workspace/child', '/workspace', '/', '/unrelated'])(
    'authorizes continuation from %s against the work directory',
    async (root) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      const cwd = fixtureCanonicalWorkDir('/workspace/child');
      f.runtime.storage.mkdirSync(cwd, { recursive: true });
      try {
        const initial = await f.drive(
          f.service.start(
            'codex',
            { prompt: 'first', cwd, retention: 'discard_provider_artifacts_on_terminal' },
            f.ctx,
          ),
        );
        if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        const projectRoot = fixtureCanonicalWorkDir(root);
        const ctx = { ...f.ctx, projectRoot, principal: testProjectPrincipal(projectRoot) };
        const service = f.serviceForContext(ctx);
        const request = { ...attempt(f, initial, 1, 'second'), projectRoot };
        const result = await f.drive(service.send(request, ctx));
        if (root === '/unrelated') {
          expect(result).toMatchObject({ state: 'refused', code: 'scope_mismatch' });
          expect(f.requests.map((entry) => entry.prompt)).toEqual(['first']);
          expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested')).toHaveLength(1);
        } else {
          expect(launched(result)).toMatchObject({ jobId: initial.jobId });
          await f.drive(service.waitForJobTerminal(initial.jobId, 10_000));
          f.assertIdentity(initial.jobId, [1, 2]);
          expect(f.requests[1]).toMatchObject({ action: 'resume', cwd });
          expect(f.restored).toEqual(['first\n']);
          expect(readProjectionJobConversation(f.db, initial.jobId)).toMatchObject({
            cwd,
            projectRoot: f.ctx.projectRoot,
            artifactHandles: expect.arrayContaining([expect.objectContaining({ execution: 2 })]),
          });
        }
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(['valid', 'missing', 'corrupt', 'publication_failed'] as const)(
    'recovers a queued continuation after a crash before restore with a %s archive',
    async (archive) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      try {
        const initial = await first(f);
        vi.spyOn(workDirectories, 'canonicalizeWorkDir').mockImplementation((path) => fixtureCanonicalWorkDir(path));
        const request = attempt(f, initial, 1, 'second');
        const env = f.runtime.env.get.bind(f.runtime.env);
        vi.spyOn(f.runtime.env, 'get').mockImplementation((key) => (key === 'CORAL_MAX_WORKERS' ? '1' : env(key)));
        f.admission.restoreActiveLaunch(
          'blocking-sibling',
          'codex',
          { kind: 'provider-session', id: 'blocking-sibling' },
          'default',
        );
        const crashedActivation = vi
          .spyOn(LaunchOrchestrator.prototype, 'runAsync')
          .mockImplementationOnce(() => undefined);
        const queued = launched(await f.drive(f.service.send(request, f.ctx)));
        expect(queued).toMatchObject({ jobId: initial.jobId, launchState: 'queued' });
        crashedActivation.mockRestore();
        expect(f.runtime.storage.existsSync(f.nativePath(initial.jobId))).toBe(false);
        const directory = conversationArchiveDirectory(f.runtime, initial.jobId);
        if (archive === 'missing') f.runtime.storage.rmSync(directory, { recursive: true, force: true });
        if (archive === 'corrupt') {
          const manifest = JSON.parse(f.runtime.storage.readFileSync(join(directory, 'manifest.json'), 'utf-8')) as {
            artifacts: Array<{ archivePath: string }>;
          };
          f.runtime.storage.writeFileSync(join(directory, manifest.artifacts[0].archivePath), 'corrupt');
        }
        const publication = vi.spyOn(f.runtime.storage, 'publishFileNoReplaceSync');
        if (archive === 'publication_failed')
          publication.mockReturnValue({ kind: 'failed', reason: 'restore publication failed', linked: false });
        const restarted = await f.restartProcess();
        const sibling = f.admission.restoreActiveLaunch(
          'recovered-sibling',
          'codex',
          { kind: 'provider-session', id: 'recovered-sibling' },
          'default',
        );
        expect(f.admission.releaseLaunch(sibling)).toMatchObject({ kind: 'released', admittedNext: true });
        await f.drive(restarted.waitForJobTerminal(initial.jobId, 10_000));
        if (archive === 'valid') {
          expect(f.requests).toHaveLength(2);
          expect(f.restored).toEqual(['first\n']);
          expect(publication).toHaveBeenCalledTimes(1);
          f.assertIdentity(initial.jobId, [1, 2]);
        } else {
          expect(f.requests.map((entry) => entry.prompt)).toEqual(['first']);
          expect(f.restored).toEqual([]);
          expect(f.store.readStatus(initial.jobId)).toMatchObject({ execution: 2, phase: 'error' });
          const events = f
            .events(initial.jobId)
            .filter((event) => (event.body as { execution?: number }).execution === 2);
          expect(events.filter((event) => event.type === 'job.execution.started')).toEqual([]);
          expect(events.filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(1);
          expect(events.find((event) => event.type === 'job.execution.outcome.accepted')?.body).toMatchObject({
            terminal: {
              outcome: {
                kind: 'job_fault',
                fault: { cause: { message: expect.stringContaining('Committed conversation restore failed:') } },
              },
            },
          });
          expect(publication).toHaveBeenCalledTimes(archive === 'publication_failed' ? 1 : 0);
          expect(events.filter((event) => event.type === 'job.execution.ended')).toHaveLength(1);
          expect(events.at(-1)?.type).toBe('job.execution.ended');
        }
        expect(f.admission.reservationFor(initial.jobId)).toBeNull();
        const before = f.events(initial.jobId);
        const replay = await f.drive(restarted.send(request, f.ctx));
        expect(launched(replay)).toMatchObject({ jobId: initial.jobId });
        expect(f.events(initial.jobId)).toEqual(before);
        expect(f.requests).toHaveLength(archive === 'valid' ? 2 : 1);
      } finally {
        vi.restoreAllMocks();
        await f.dispose();
      }
    },
  );

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
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(['codex', 'claude'])(
    'archives a finished %s continuation again, so the next continuation restores the whole conversation',
    async (provider) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      try {
        const initial = await first(f, provider);
        const second = launched(await f.drive(f.service.send(attempt(f, initial, 1, 'second'), f.ctx)));
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        expect(f.runtime.storage.existsSync(f.nativePath(initial.jobId, provider))).toBe(false);

        launched(await f.drive(f.service.send(attempt(f, second, 2, 'third'), f.ctx)));
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        expect(f.restored).toEqual(['first\n', 'first\nsecond\n']);
        expect(f.runtime.storage.existsSync(f.nativePath(initial.jobId, provider))).toBe(false);
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
      expect(second.execution).toBe(2);
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      const third = launched(await f.drive(f.service.send(attempt(f, second, 2, 'third'), f.ctx)));
      expect(third.execution).toBe(3);
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      const restarted = f.restartCoordinator();
      for (let n = 0; n < 2; n++)
        expect(await f.drive(restarted.send(request, f.ctx))).toEqual({ state: 'launched', launch: second });
      expect(f.requests.map((request) => request.prompt)).toEqual(['first', 'second', 'third']);
      expect(f.restored).toEqual(['first\n', 'first\nsecond\n']);
      f.assertIdentity(initial.jobId, [1, 2, 3]);
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
      expect(text).toContain(`Job ${second.jobId} execution #2 provider exited 7`);
      expect(text).not.toContain('execution #3');
      expect(text).toContain('second result');
      expect(text).toContain(`/executions/2/result.md`);
      expect(text).not.toContain(`/executions/3/result.md`);
      expect(text).not.toContain('third result');
    } finally {
      await f.dispose();
    }
  });

  it('releases admission and propagates a commit failure with no persisted request', async () => {
    const f = conversationIdentityFixture({ managedArtifacts: true });
    try {
      const initial = await first(f);
      const before = f.events(initial.jobId);
      f.failNextCommit();
      await expect(f.drive(f.service.send(attempt(f, initial, 1, 'second'), f.ctx))).rejects.toThrow(
        'Request commit failed before persistence',
      );
      expect(f.events(initial.jobId)).toEqual(before);
      expect(f.admission.reservationFor(initial.jobId)).toBeNull();
      expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
      expect(f.restored).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  it.each(['input', 'execution'] as const)(
    'refuses mismatched %s evidence after an uncertain commit',
    async (field) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      try {
        const initial = await first(f);
        const read = executionJournal.findCommittedExecutionRequest;
        const previous = executionJournal.readExecutionRequestAt(f.db, initial.jobId, initial.requestedSeq, f.readCtx);
        if (previous === null) throw new Error('Expected committed initial execution');
        let calls = 0;
        vi.spyOn(executionJournal, 'findCommittedExecutionRequest').mockImplementation((...args) => {
          if (++calls === 2)
            return {
              ...previous,
              request: {
                ...previous.request,
                execution: field === 'execution' ? 9 : 2,
                input: field === 'input' ? 'another input' : 'second',
              },
            };
          return read(...args);
        });
        const before = f.events(initial.jobId);
        f.failNextCommit();
        expect(await f.drive(f.service.send(attempt(f, initial, 1, 'second'), f.ctx))).toMatchObject({
          state: 'refused',
          code: 'continuation_target_changed',
        });
        expect(f.admission.reservationFor(initial.jobId)).toBeNull();
        expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
        expect(f.restored).toEqual([]);
        expect(f.events(initial.jobId)).toEqual(before);
      } finally {
        await f.dispose();
      }
    },
  );

  it.each([
    { redrive: 'automatic', failure: 'status' },
    { redrive: 'explicit', failure: 'status' },
    { redrive: 'automatic', failure: 'acceptance' },
  ] as const)(
    'holds committed launch setup failure on $failure until $redrive redrive ends it',
    async ({ redrive, failure }) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      let held = true;
      try {
        const initial = await first(f);
        f.blockAcceptance(failure === 'acceptance');
        const mkdir = f.runtime.storage.mkdirSync.bind(f.runtime.storage);
        vi.spyOn(f.runtime.storage, 'mkdirSync').mockImplementation((path, options) => {
          if (path === f.store.jobDir(initial.jobId)) throw new Error('Launch directory unavailable');
          return mkdir(path, options);
        });
        const readStatus = f.store.readStatus.bind(f.store);
        vi.spyOn(f.store, 'readStatus').mockImplementation((...args) => {
          const status = readStatus(...args);
          if (held && failure === 'status' && status?.execution === 2)
            throw new Error('Setup recovery status unavailable');
          return status;
        });
        const request = attempt(f, initial, 1, 'second');
        let completed = false;
        const sending = f.service.send(request, f.ctx).then((result) => {
          completed = true;
          return result;
        });
        void sending.catch(() => undefined);
        const address = { jobId: initial.jobId, execution: 2 };
        for (let n = 0; n < 12 && f.finisher.status(address)?.kind !== 'blocked'; n++) {
          await flushMicrotasks(100);
          f.runtime.time.tick(5000);
        }
        const status = f.finisher.status(address);
        expect(status).toMatchObject({
          stage: 'accept',
          kind: 'blocked',
          reason: failure === 'status' ? 'Setup recovery status unavailable' : 'Outcome acceptance storage unavailable',
          successor: 'live-retry',
        });
        expect(f.finisher.owns(address)).toBe(true);
        expect(completed).toBe(false);
        expect(f.store.loadJobDetailResponse(initial.jobId)?.status?.finishingStatus).toEqual(status);
        expect(f.store.listJobProjections()[0].status.finishingStatus).toEqual(status);
        expect(f.finisher.admissionStatuses()).toEqual([{ ...address, status }]);
        expect(listExecutionRetryStatuses(f.db)).toEqual({ statuses: [], skipped: 0 });
        expect(f.admission.reservationFor(initial.jobId)).not.toBeNull();
        expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
        held = false;
        f.blockAcceptance(false);
        if (redrive === 'explicit') await f.drive(f.finisher.redrive(address));
        expect(launched(await f.drive(sending))).toMatchObject({ jobId: initial.jobId });
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        expect(readExecutionRetryStatus(f.db, address)).toBeNull();
        expect(f.admission.reservationFor(initial.jobId)).toBeNull();
        expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
        const events = f.events(initial.jobId);
        expect(events.filter((event) => event.type === 'job.execution.requested')).toHaveLength(2);
        expect(events.filter((event) => event.type === 'job.execution.ended')).toHaveLength(2);
        expect(f.store.readStatus(initial.jobId)).toMatchObject({ execution: 2, phase: 'error' });
        expect(await f.drive(f.service.send(request, f.ctx))).toMatchObject({ state: 'launched' });
        expect(f.events(initial.jobId)).toEqual(events);
      } finally {
        held = false;
        f.blockAcceptance(false);
        vi.restoreAllMocks();
        await f.dispose();
      }
    },
  );

  it.each(['automatic', 'explicit'] as const)(
    'hands unreadable commit evidence to admission recovery, then finalizes on %s redrive without relaunching',
    async (redrive) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      try {
        const initial = await first(f);
        const read = executionJournal.findCommittedExecutionRequest;
        let unreadable = true;
        vi.spyOn(executionJournal, 'findCommittedExecutionRequest').mockImplementation((...args) => {
          const evidence = read(...args);
          if (unreadable && evidence !== null) throw new Error('Evidence unavailable');
          return evidence;
        });
        f.loseNextRequestCommitAcknowledgement();
        const result = await f.drive(f.service.send(attempt(f, initial, 1, 'second'), f.ctx));
        expect(result).toMatchObject({
          state: 'unknown',
          reason: expect.stringContaining('successor=continuation admission recovery'),
        });
        const address = { jobId: initial.jobId, execution: 2 };
        for (let n = 0; n < 12 && f.finisher.status(address)?.kind !== 'blocked'; n++) {
          f.runtime.time.tick(5000);
          await flushMicrotasks(100);
        }
        expect(f.finisher.owns(address)).toBe(true);
        expect(
          RecoveryQuarantineStore.readOnly(f.db).readEntry('job-execution-finishing', executionKey(initial.jobId, 2)),
        ).toBeNull();
        expect(f.finisher.status(address)).toMatchObject({ kind: 'blocked', successor: 'live-retry' });
        expect(f.admission.reservationFor(initial.jobId)).not.toBeNull();
        expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
        unreadable = false;
        vi.spyOn(f.store, 'readStatus').mockImplementationOnce(() => {
          throw new Error('Finalization status temporarily unreadable');
        });
        if (redrive === 'explicit') await f.drive(f.finisher.redrive(address));
        else {
          f.runtime.time.tick(5000);
          await flushMicrotasks(100);
        }
        expect(f.finisher.status(address)).toMatchObject({
          kind: 'blocked',
          reason: 'Finalization status temporarily unreadable',
          successor: 'live-retry',
        });
        expect(f.finisher.owns(address)).toBe(true);
        expect(f.admission.reservationFor(initial.jobId)).not.toBeNull();
        expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(
          1,
        );
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        expect(
          RecoveryQuarantineStore.readOnly(f.db).readEntry('job-execution-finishing', executionKey(initial.jobId, 2)),
        ).toBeNull();
        expect(f.admission.reservationFor(initial.jobId)).toBeNull();
        expect(f.finisher.owns(address)).toBe(false);
        expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
        expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested')).toHaveLength(2);
        expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.outcome.accepted')).toHaveLength(
          2,
        );
        expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.ended')).toHaveLength(2);
        expect(f.store.readStatus(initial.jobId)).toMatchObject({ execution: 2, phase: 'error' });
      } finally {
        await f.dispose();
      }
    },
  );

  it.each(['committed', 'absent'] as const)(
    'restarts an uncertain admission with its request %s through durable startup evidence',
    async (requestState) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      try {
        const initial = await first(f);
        const read = executionJournal.findCommittedExecutionRequest;
        let unreadable = requestState === 'committed';
        vi.spyOn(executionJournal, 'findCommittedExecutionRequest').mockImplementation((...args) => {
          const evidence = read(...args);
          if (unreadable && (requestState === 'absent' || evidence !== null))
            throw new Error('Commit evidence unreadable');
          return evidence;
        });
        if (requestState === 'committed') f.loseNextRequestCommitAcknowledgement();
        else
          vi.spyOn(f.store, 'commit').mockImplementationOnce(() => {
            unreadable = true;
            throw new Error('Request commit failed before persistence');
          });
        const request = attempt(f, initial, 1, 'second');
        expect(await f.drive(f.service.send(request, f.ctx))).toMatchObject({ state: 'unknown' });
        const address = { jobId: initial.jobId, execution: 2 };
        for (let n = 0; n < 12 && f.finisher.status(address)?.kind !== 'blocked'; n++) {
          f.runtime.time.tick(5000);
          await flushMicrotasks(100);
        }
        expect(f.finisher.status(address)).toMatchObject({ kind: 'blocked', stage: 'accept' });
        expect(f.admission.reservationFor(initial.jobId)).not.toBeNull();
        expect(f.store.loadJobDetailResponse(initial.jobId)?.status.finishingStatus).toEqual(
          f.finisher.status(address),
        );
        expect(f.store.listJobProjections()[0].status.finishingStatus).toEqual(f.finisher.status(address));
        expect(listExecutionRetryStatuses(f.db)).toEqual({ statuses: [], skipped: 0 });
        const restarted = await f.restartProcess();
        expect(f.finisher.admissionStatuses()).toEqual([]);
        expect(f.admission.reservationFor(initial.jobId)).toBeNull();
        expect(listExecutionRetryStatuses(f.db)).toEqual({ statuses: [], skipped: 0 });
        expect(f.requests.map((entry) => entry.prompt)).toEqual(['first']);
        const requests = f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested');
        if (requestState === 'committed') {
          await f.drive(restarted.waitForJobTerminal(initial.jobId, 10_000));
          expect(requests).toHaveLength(2);
          expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.ended')).toHaveLength(2);
          await f.finisher.redrive(address);
          unreadable = false;
          expect(await f.drive(restarted.send(request, f.ctx))).toMatchObject({ state: 'launched' });
          expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested')).toEqual(requests);
        } else {
          expect(requests).toHaveLength(1);
          unreadable = false;
          expect(await f.drive(restarted.send(request, f.ctx))).toMatchObject({ state: 'launched' });
          await f.drive(restarted.waitForJobTerminal(initial.jobId, 10_000));
          expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested')).toHaveLength(2);
          expect(f.requests.map((entry) => entry.prompt)).toEqual(['first', 'second']);
        }
      } finally {
        vi.restoreAllMocks();
        await f.dispose();
      }
    },
  );

  it.each(['archive_missing', 'archive_hash_mismatch'] as const)(
    'refuses %s under a continuation target before committing',
    async (code) => {
      const f = conversationIdentityFixture({ managedArtifacts: true });
      try {
        const initial = await first(f);
        const directory = conversationArchiveDirectory(f.runtime, initial.jobId);
        if (code === 'archive_missing') f.runtime.storage.rmSync(directory, { recursive: true, force: true });
        else {
          const manifest = JSON.parse(f.runtime.storage.readFileSync(join(directory, 'manifest.json'), 'utf-8')) as {
            artifacts: Array<{ archivePath: string }>;
          };
          f.runtime.storage.writeFileSync(join(directory, manifest.artifacts[0].archivePath), 'corrupt');
        }
        const before = f.events(initial.jobId);
        expect(
          await f.drive(
            f.service.resume(
              'codex',
              { jobId: initial.jobId, prompt: 'second', continuationTarget: attempt(f, initial, 1, 'second').target },
              f.ctx,
            ),
          ),
        ).toMatchObject({ status: 'refused', code });
        expect(f.events(initial.jobId)).toEqual(before);
        expect(f.admission.reservationFor(initial.jobId)).toBeNull();
        expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
      } finally {
        await f.dispose();
      }
    },
  );

  it('refuses an outstanding admission under a continuation target as execution_finishing', async () => {
    const f = conversationIdentityFixture({ managedArtifacts: true });
    try {
      const initial = await first(f);
      const reservation = f.admission.requestLaunch(
        initial.jobId,
        'codex',
        { kind: 'provider-session', id: initial.jobId },
        'default',
      );
      if (reservation === 'queue_full' || reservation.type !== 'immediate')
        throw new Error('Expected immediate reservation');
      const before = f.events(initial.jobId);
      expect(
        await f.drive(
          f.service.resume(
            'codex',
            { jobId: initial.jobId, prompt: 'second', continuationTarget: attempt(f, initial, 1, 'second').target },
            f.ctx,
          ),
        ),
      ).toMatchObject({ status: 'refused', code: 'execution_finishing' });
      expect(f.events(initial.jobId)).toEqual(before);
      expect(f.requests).toHaveLength(1);
      void f.admission.releaseLaunch(reservation.permit);
    } finally {
      await f.dispose();
    }
  });

  it('accepts a coordinator epoch address with the same lineage in both launch checks', async () => {
    const f = conversationIdentityFixture({ managedArtifacts: true });
    try {
      const initial = await first(f);
      const request = attempt(f, initial, 1, 'second');
      const target = {
        ...request.target,
        sourceEpoch: JSON.stringify({ storeRoot: '/store', epoch: 'epoch-1', lineageKey: initial.epochKey }),
      };
      expect(
        await f.drive(
          f.service.resume(
            'codex',
            {
              jobId: initial.jobId,
              prompt: 'second',
              originatingClientMessageId: request.clientMessageId,
              continuationTarget: target,
            },
            f.ctx,
          ),
        ),
      ).toMatchObject({ status: 'running', jobId: initial.jobId });
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      f.assertIdentity(initial.jobId, [1, 2]);
    } finally {
      await f.dispose();
    }
  });
  it.each([false, true])('resolves a same-ID commit race with conflicting input=%s', async (conflicting) => {
    const f = conversationIdentityFixture();
    let jobId: string | undefined;
    try {
      const initial = await first(f);
      jobId = initial.jobId;
      const request = attempt(f, initial, 1, 'second');
      const admit = f.store.withExecutionAdmission.bind(f.store);
      let winnerSeq: number | undefined;
      vi.spyOn(f.store, 'withExecutionAdmission').mockImplementation((jobId, execution, subject, action) => {
        if (execution === 2 && winnerSeq === undefined) {
          const winner = f.append(
            {
              ...requestedExecution(2, {
                input: conflicting ? 'different' : request.input,
                originatingClientMessageId: request.clientMessageId,
              }),
              stream: { kind: 'job', id: jobId },
            },
            executionInput('job.execution.queued', { execution: 2, queuePosition: 1, runningJobIds: [] }, jobId),
          );
          winnerSeq = winner[0].seq;
        }
        admit(jobId, execution, subject, action);
      });
      const result = await f.drive(f.service.send(request, f.ctx));
      if (conflicting) expect(result).toMatchObject({ state: 'refused', code: 'continuation_target_changed' });
      else
        expect(launched(result)).toMatchObject({
          jobId: initial.jobId,
          requestedSeq: winnerSeq,
          launchState: 'queued',
        });
      expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested')).toHaveLength(2);
      expect(f.admission.reservationFor(initial.jobId)).toBeNull();
      expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
    } finally {
      vi.restoreAllMocks();
      if (jobId !== undefined && f.store.readStatus(jobId)?.execution === 2) {
        const winnerJobId = jobId;
        f.commit((c) => {
          appendJobExecutionOutcomeAccepted(c, {
            jobId: winnerJobId,
            execution: 2,
            terminal: { content: 'winner', outcome: { kind: 'completed' }, durationMs: 1 },
          });
          return undefined;
        });
      }
      await f.dispose();
    }
  });

  it('rechecks the ended predecessor in the request commit transaction', async () => {
    const f = conversationIdentityFixture();
    try {
      const initial = await f.drive(f.service.start('codex', { prompt: 'first' }, f.ctx));
      if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      const request = attempt(f, initial, 1, 'loser');
      const admit = f.store.withExecutionAdmission.bind(f.store);
      let advanced = false;
      vi.spyOn(f.store, 'withExecutionAdmission').mockImplementation((jobId, execution, subject, action) => {
        if (!advanced && execution === 2) {
          advanced = true;
          f.commit((c) => {
            c.append({
              ...requestedExecution(2, { input: 'winner', originatingClientMessageId: nextMessageId(9) }),
              stream: { kind: 'job', id: jobId },
            });
            c.append(executionInput('job.execution.admitted', { execution: 2, queuePosition: 0 }, jobId));
            const causeRef = appendJobExecutionOutcomeAccepted(c, {
              jobId,
              execution: 2,
              terminal: { content: 'winner', outcome: { kind: 'completed' }, durationMs: 1 },
            });
            appendJobExecutionEnded(c, { jobId, execution: 2, causeRef });
            return undefined;
          });
        }
        admit(jobId, execution, subject, action);
      });
      expect(await f.drive(f.service.send(request, f.ctx))).toMatchObject({
        state: 'refused',
        code: 'continuation_target_changed',
      });
      expect(f.events(initial.jobId).filter((event) => event.type === 'job.execution.requested')).toHaveLength(2);
      expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
      expect(f.admission.reservationFor(initial.jobId)).toBeNull();
    } finally {
      await f.dispose();
    }
  });
});
