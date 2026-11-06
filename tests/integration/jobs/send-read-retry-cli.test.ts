import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('#src/transport/ipc/ensure.js', () => {
  const client = { request: ipc.request };
  return {
    ensure: vi.fn(async () => client),
    issueWithSuccessorAfterLifecycleRefusal: vi.fn(
      async (_method: string, _pluginRoot: string | undefined, issue: (reached: unknown) => Promise<unknown>) =>
        issue(client),
    ),
  };
});
vi.mock('#src/infra/backend-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof BackendDiscoveryMod>()),
  readDiscoveryRecordDisposition: () => ({ kind: 'missing' }),
}));

import { registerSessionCommands } from '#src/cli/commands/session.js';
import * as conversationReads from '#src/jobs/conversation/read-queries.js';
import { jobSendOutcomeSchema } from '#src/jobs/send.js';
import { ProjectionConversationMalformedError } from '#src/jobs/records.js';
import { jobSendSchema } from '#src/transport/rpc/jobs.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  ipc.request.mockReset();
  process.exitCode = undefined;
});

it.each([
  'transient',
  'unreadable',
  'lost-response',
  'malformed',
  'wrong-provider',
  'wrong-owner',
  'missing',
  'wrong-owner-lost-response',
  'missing-lost-response',
  'missing-unknown-workdir',
  'concurrent-continuation',
] as const)('renders %s owner-read evidence through jobs send and the CLI command', async (evidence) => {
  const lostResponse = evidence === 'lost-response' || evidence.endsWith('-lost-response');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coral-send-read-cli-')));
  const profile = join(directory, 'codex-profile');
  mkdirSync(profile);
  vi.stubEnv('CODEX_HOME', profile);
  for (const key of [
    'CORAL_CHILD',
    'CORAL_CHILD_PRINCIPAL_HANDLE',
    'CORAL_CHILD_CREDENTIAL_ID',
    'CORAL_CHILD_CREDENTIAL_KEY',
    'CORAL_JOB_ID',
  ])
    vi.stubEnv(key, '');
  const f = conversationIdentityFixture({ stall: evidence === 'concurrent-continuation' });
  const cwd = fixtureCanonicalWorkDir(join(directory, 'child work'));
  f.runtime.storage.mkdirSync(cwd, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const ctx = {
    ...f.ctx,
    providerScope: {
      origin: 'caller' as const,
      profiles: [{ provider: 'codex', profile: { canonicalLocation: profile, routing: { kind: 'home' } } }],
    },
  };
  try {
    const initial = await f.drive(f.service.start('codex', { prompt: 'first', cwd }, ctx));
    if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
    if (evidence === 'concurrent-continuation') f.finish(initial.jobId);
    await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
    expect(f.store.readStatus(initial.jobId)).toMatchObject({ phase: 'completed', execution: 1 });
    const history = f.events(initial.jobId);
    const before = f.runtime.time.now();
    const sleep = vi.spyOn(f.runtime.time, 'sleep');
    const read = conversationReads.readProjectionJobConversation;
    let failures = 0;
    const reader = vi.spyOn(conversationReads, 'readProjectionJobConversation').mockImplementation((...args) => {
      if (evidence === 'transient' && failures === 1) return read(...args);
      failures++;
      if (evidence.startsWith('missing')) return null;
      if (evidence.startsWith('wrong-owner')) return { ...read(...args)!, projectRoot: '/other-owner' };
      if (evidence === 'malformed')
        throw new ProjectionConversationMalformedError(
          initial.jobId,
          new TypeError('Malformed conversation facet'),
          cwd,
          { kind: 'provider-session', id: initial.jobId },
        );
      if (evidence === 'wrong-provider') return { ...read(...args)!, provider: 'claude' };
      throw new Error('Conversation storage temporarily unreadable');
    });
    const attempts: unknown[] = [];
    const outcomes: unknown[] = [];
    let concurrentDecision: unknown;
    ipc.request.mockImplementation(async (method: string, params: unknown) => {
      if (method === 'jobs.detail') {
        const detail = f.store.loadJobDetailResponse(initial.jobId)!;
        return {
          ...detail,
          status: {
            ...detail.status,
            workDir: evidence === 'missing-unknown-workdir' ? undefined : detail.status.workDir,
          },
          epochKey: initial.epochKey,
        };
      }
      if (method !== 'jobs.send') throw new Error(`Unexpected RPC ${method}`);
      const request = jobSendSchema.parse(params);
      attempts.push(request);
      const projectRoot = canonicalWorkDirWireSchema.parse(request.projectRoot);
      const result = await f.service.send(
        { ...request, projectRoot },
        {
          ...ctx,
          projectRoot,
          principal: testProjectPrincipal(projectRoot),
          providerScope: request.providerScope,
        },
      );
      const wire = jobSendOutcomeSchema.parse(result);
      outcomes.push(wire);
      if (evidence === 'concurrent-continuation') {
        reader.mockRestore();
        concurrentDecision = await f.service.send(
          {
            ...request,
            projectRoot,
            input: 'another continuation',
            clientMessageId: '77777777-7777-4777-8777-777777777777',
          },
          { ...ctx, projectRoot, principal: testProjectPrincipal(projectRoot) },
        );
      }
      if (lostResponse && attempts.length === 1) throw new Error('Send response lost');
      return wire;
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const program = new Command().name('coral-cli');
    registerSessionCommands(program, f.providers);
    const input = 'second input with spaces';
    await f.drive(program.parseAsync(['jobs', 'send', initial.jobId, '-d', '-i', input], { from: 'user' }));
    reader.mockRestore();
    expect(attempts[0]).toMatchObject({ input, projectRoot: directory });
    const out = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    const err = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    if (evidence === 'concurrent-continuation')
      expect(concurrentDecision, JSON.stringify(concurrentDecision)).toMatchObject({
        state: 'launched',
        launch: { jobId: initial.jobId, execution: 2 },
      });
    if (evidence === 'transient') {
      await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
      expect(process.exitCode).toBe(0);
      expect(err).toBe('');
      expect(out).toContain(`Provider job ${initial.jobId} execution #2`);
      expect(failures).toBe(1);
      expect(attempts).toHaveLength(1);
      f.assertIdentity(initial.jobId, [1, 2]);
      expect(f.requests.map((request) => request.prompt)).toEqual(['first', input]);
    } else {
      const code =
        evidence === 'malformed'
          ? 'conversation_malformed'
          : evidence === 'wrong-provider'
            ? 'conversation_provider_mismatch'
            : evidence.startsWith('wrong-owner')
              ? 'conversation_owner_mismatch'
              : evidence.startsWith('missing')
                ? 'conversation_missing'
                : 'conversation_unobservable';
      expect(process.exitCode).toBe(1);
      expect(out).toBe('');
      expect(outcomes).toEqual(
        Array.from({ length: lostResponse ? 2 : 1 }, () => expect.objectContaining({ state: 'refused', code })),
      );
      expect(err).toContain(`Message refused (${code})`);
      expect(err).toContain('This attempt was not admitted and delivered no input.');
      expect(err.includes('An earlier invocation may have delivered this message')).toBe(lostResponse);
      expect(err).not.toMatch(/command=|coral-cli|safe to resend|start a new|choose|verify|pipe|resupply/iu);
      if (evidence === 'missing-unknown-workdir') expect(err).toContain('recorded work directory is unavailable');
      else expect(err).toContain(cwd);
      expect(err).toContain('Execution owner: provider-session');
      if (evidence === 'concurrent-continuation') {
        expect(f.store.readStatus(initial.jobId)).toMatchObject({ execution: 2, phase: 'running' });
        f.finish(initial.jobId);
        await f.drive(f.service.waitForJobTerminal(initial.jobId, 10_000));
        f.assertIdentity(initial.jobId, [1, 2]);
        expect(f.requests.map((request) => request.prompt)).toEqual(['first', 'another continuation']);
      } else {
        expect(f.events(initial.jobId)).toEqual(history);
        expect(f.requests.map((request) => request.prompt)).toEqual(['first']);
      }
      expect(f.admission.reservationFor(initial.jobId)).toBeNull();
      expect(attempts).toHaveLength(lostResponse ? 2 : 1);
      if (lostResponse) expect(attempts[1]).toEqual(attempts[0]);
      if (code === 'conversation_unobservable') {
        expect(err).toContain('3 read attempts');
        expect(err).toContain('1000ms deadline');
        expect(failures).toBe(lostResponse ? 6 : 3);
        expect(sleep.mock.calls.filter(([ms]) => ms === 100)).toHaveLength(lostResponse ? 4 : 2);
        if (evidence !== 'concurrent-continuation') expect(f.runtime.time.now() - before).toBeLessThanOrEqual(1000);
      } else expect(failures).toBe(lostResponse ? 2 : 1);
    }
  } finally {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await f.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
