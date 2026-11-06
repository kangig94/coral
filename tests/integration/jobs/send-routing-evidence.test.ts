import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Statement } from '#src/store/db.js';
import { Command } from 'commander';
import { afterEach, expect, it, vi } from 'vitest';
import type * as BackendDiscoveryMod from '#src/infra/backend-discovery.js';

const ipc = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('#src/transport/ipc/ensure.js', () => {
  const client = { request: ipc.request };
  return {
    ensure: vi.fn(async () => client),
    issueWithSuccessorAfterLifecycleRefusal: vi.fn(
      async (_method: string, _root: string | undefined, issue: (client: unknown) => Promise<unknown>) => issue(client),
    ),
  };
});
vi.mock('#src/infra/backend-discovery.js', async (original) => ({
  ...(await original<typeof BackendDiscoveryMod>()),
  readDiscoveryRecordDisposition: () => ({ kind: 'missing' }),
}));

import { registerSessionCommands } from '#src/cli/commands/session.js';
import { createCoordinatorRpcPorts } from '#src/coordinator/composition/rpc-ports.js';
import { ChildPrincipalRegistry } from '#src/coordinator/child-principal-registry.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { IpcRpcError } from '#src/transport/ipc/client.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { InvocationContext } from '#src/runtime/invocation-context.js';
import { canonicalWorkDirWireSchema } from '#src/runtime/canonical-work-dir.js';
import { conversationIdentityFixture } from '#tests/integration/jobs/conversation-identity-fixture.js';
import { requestedExecution, executionInput } from '#tests/helpers/job-executions.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { buildWorkflowPlan } from '#src/workflow/plan.js';
import { parseExpression } from '#src/workflow/parser.js';
import { workflowPlanDeclaredEvent } from '#src/workflow/events.js';
import { TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import * as executionJournal from '#src/jobs/execution-journal.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  ipc.request.mockReset();
  process.exitCode = undefined;
});

function routing(f: ReturnType<typeof conversationIdentityFixture>) {
  const services = new Map<string, ReturnType<typeof f.serviceForContext>>();
  const createOwnerInvocationContext = (root: string): InvocationContext => {
    const projectRoot = canonicalWorkDirWireSchema.parse(root);
    return {
      projectRoot,
      pluginRoot: '/plugin',
      coralEnv: {},
      principal: {
        subject: 'system',
        transport: 'internal',
        credential: { kind: 'internal', id: 'recovery' },
        binding: { kind: 'project', root: projectRoot },
      },
    };
  };
  const rpc = createCoordinatorRpcPorts({
    createOwnerInvocationContext,
    time: f.runtime.time,
    services: {
      getExecutionService: (ctx: InvocationContext) => {
        let service = services.get(ctx.projectRoot);
        if (service === undefined) {
          service = f.serviceForContext(ctx);
          services.set(ctx.projectRoot, service);
        }
        return service;
      },
    },
    getProgressStore: () => f.store,
    jobAddressing: { detail: (id: string) => ({ ...f.store.loadJobDetailResponse(id), epochKey: ':memory:' }) },
  } as unknown as Parameters<typeof createCoordinatorRpcPorts>[0]);
  return { rpc, services };
}

it('first cross-project send creates owner-bound recovery authority independently of a refused caller attempt', async () => {
  const f = conversationIdentityFixture();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coral-owner-recovery-')));
  const projectRoot = canonicalWorkDirWireSchema.parse(directory);
  const ownerCtx = { ...f.ctx, projectRoot, principal: testProjectPrincipal(projectRoot) };
  const ownerService = f.serviceForContext(ownerCtx);
  try {
    const cwd = canonicalWorkDirWireSchema.parse(join(directory, 'child'));
    mkdirSync(cwd);
    f.runtime.storage.mkdirSync(cwd, { recursive: true });
    const initial = await f.drive(ownerService.start('codex', { prompt: 'first', cwd }, ownerCtx));
    if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
    await f.drive(ownerService.waitForJobTerminal(initial.jobId, 10_000));
    f.append(
      { ...requestedExecution(2), stream: { kind: 'job', id: initial.jobId } },
      executionInput('job.execution.queued', { execution: 2, queuePosition: 1, runningJobIds: [] }, initial.jobId),
    );
    const { rpc, services } = routing(f);
    const caller = { ...ownerCtx, projectRoot: cwd, principal: testProjectPrincipal(cwd) };
    const result = await f.drive(
      rpc.jobs.send(
        {
          projectRoot: cwd,
          jobId: initial.jobId,
          input: 'ignored',
          clientMessageId: '33333333-3333-4333-8333-333333333333',
          target: { mode: 'continue', execution: 1, requestedSeq: initial.requestedSeq, sourceEpoch: initial.epochKey },
        },
        caller,
      ),
    );
    expect(result).toMatchObject({ state: 'refused', code: 'continuation_target_changed' });
    expect(services.size).toBe(1);
    const recovered = services.get(ownerCtx.projectRoot)!;
    const registration = vi.spyOn(ChildPrincipalRegistry.prototype, 'register');
    const launch = f.store.loadJobProjectionDetail(initial.jobId).launch!;
    const captured = await f.drive(recovered.captureProviderRecoveryAuthority(launch));
    if (!captured.ok) throw new Error(captured.failure.reason);
    const sibling = f.admission.restoreActiveLaunch(
      'recovery-trigger',
      'codex',
      { kind: 'provider-session', id: 'recovery-trigger' },
      'default',
    );
    await f.drive(recovered.recoverQueuedJob(captured.authority));
    f.admission.releaseLaunch(sibling);
    await f.drive(recovered.waitForJobTerminal(initial.jobId, 10_000));
    const recoveryIndex = registration.mock.calls.findIndex(([value]) => value.issuer === 'job-recovery');
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(registration.mock.calls[recoveryIndex][0].parentPrincipal).toMatchObject({
      subject: 'system',
      binding: { kind: 'project', root: ownerCtx.projectRoot },
    });
    expect(registration.mock.results[recoveryIndex].value.authorization.principalWire.binding).toEqual({
      kind: 'project',
      root: ownerCtx.projectRoot,
    });
    expect(f.store.readStatus(initial.jobId)).toMatchObject({ phase: 'completed' });
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([
  ['{', 'provider-session'],
  [null, 'provider-session'],
  ['{}', 'provider-session'],
  ['{', 'workflow'],
  ['{', 'discussion'],
  ['{', 'unknown'],
] as const)(
  'classifies real persisted facet %s owned by %s before CLI delivery while preserving caller scope',
  async (facet, ownerKind) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coral-send-corruption-')));
    const f = conversationIdentityFixture();
    const projectRoot = canonicalWorkDirWireSchema.parse(directory);
    const cwd = canonicalWorkDirWireSchema.parse(join(directory, 'child'));
    mkdirSync(cwd);
    f.runtime.storage.mkdirSync(cwd, { recursive: true });
    const ctx = { ...f.ctx, projectRoot, principal: testProjectPrincipal(projectRoot) };
    const owner = f.serviceForContext(ctx);
    let initialId: string | undefined;
    let savedFacet: string | undefined;
    let savedOwner: string | undefined;
    try {
      const operationId = f.runtime.ids.uuid();
      let workflowSlotId: string | undefined;
      if (ownerKind === 'workflow') {
        const plan = buildWorkflowPlan(operationId, parseExpression('architect'), { defaultProvider: 'codex' });
        workflowSlotId = plan.slots[0].slotId;
        f.commit((commit) => {
          commit.append(workflowPlanDeclaredEvent(operationId, plan, TEST_PROVIDER_SCOPE));
          return undefined;
        });
      }
      if (ownerKind === 'discussion') {
        f.append({
          type: 'discuss.session.created',
          stream: { kind: 'discuss', id: operationId },
          project: projectRoot,
          body: {
            sourceSeq: 1,
            input: {
              topic: 'Malformed child evidence',
              agents: [{ name: 'architect', persona: 'Architect', participation: 'required' }],
              min_bid_delay_ms: 0,
            },
            config: { bidThreshold: 0, maxEpochs: 2, quotaPerEpoch: 2 },
            agentExecution: { architect: { manual: false, provider: 'codex', model: 'fixture' } },
            providerScope: TEST_PROVIDER_SCOPE,
          },
        });
      }
      const initial = await f.drive(
        owner.start(
          'codex',
          {
            prompt: 'first',
            cwd,
            ...(ownerKind === 'workflow'
              ? {
                  owner: { kind: 'workflow' as const, id: operationId },
                  parentWorkflowJobId: operationId,
                  workflowSlotId,
                }
              : {}),
            ...(ownerKind === 'discussion'
              ? {
                  owner: { kind: 'discussion' as const, id: operationId },
                  discussionRun: { agent: 'architect', purpose: 'speech' as const, attempt: 1 },
                }
              : {}),
          },
          ctx,
        ),
      );
      if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
      initialId = initial.jobId;
      await f.drive(owner.waitForJobTerminal(initial.jobId, 10_000));
      const before = f.events(initial.jobId);
      savedFacet = f.db
        .prepare<[string], { facet: string }>('SELECT facet FROM projection_jobs WHERE job_id = ?')
        .get(initial.jobId)!.facet;
      savedOwner = f.db
        .prepare<[string], { execution_owner: string }>('SELECT execution_owner FROM projection_jobs WHERE job_id = ?')
        .get(initial.jobId)!.execution_owner;
      f.db.prepare('UPDATE projection_jobs SET facet = ? WHERE job_id = ?').run(facet, initial.jobId);
      if (ownerKind === 'unknown')
        f.db.prepare('UPDATE projection_jobs SET execution_owner = ? WHERE job_id = ?').run('{', initial.jobId);
      const { rpc, services } = routing(f);
      const ports = {
        identity: { pluginRoot: '/plugin' },
        coralEnvSnapshot: {},
        admin: { isLaunchFenceActive: () => false },
        jobs: rpc.jobs,
      } as unknown as HttpHandlerPorts;
      const detailSpec = rpcCatalog.find((candidate) => candidate.name === 'jobs.detail')!;
      const detailReply = await executeCatalogRequest(
        detailSpec,
        detailSpec.requestSchema.parse({ jobId: initial.jobId, projectRoot }),
        ports,
        ctx.principal,
      );
      expect(detailReply).toMatchObject({
        kind: 'unary',
        statusCode: 409,
        body: {
          code: 'conversation_malformed',
          detail: {
            workDir: cwd,
            owner: ownerKind === 'unknown' ? null : expect.objectContaining({ kind: ownerKind }),
            sendRefusal: { state: 'refused', code: 'conversation_malformed' },
          },
        },
      });
      if (detailReply.kind !== 'unary') throw new Error('Expected detail refusal');
      const detailMessage = (detailReply.body as { message: string }).message;
      expect(detailMessage).toContain('Job detail could not be decoded');
      expect(detailMessage).not.toMatch(/admitted|delivered/);
      expect(detailMessage).toContain(cwd);
      if (ownerKind === 'provider-session')
        expect(detailMessage).toContain(`Execution owner: provider-session ${initial.jobId}.`);
      expect(detailMessage).not.toMatch(/command=|coral-cli|safe to resend|Start a new/);
      if (ownerKind === 'workflow' || ownerKind === 'discussion')
        expect(detailMessage).toContain(`owning ${ownerKind} operation ${operationId}`);
      if (ownerKind === 'unknown') expect(detailMessage).toContain('Ownership could not be established');
      const methods: string[] = [];
      ipc.request.mockImplementation(async (method: string, params: unknown) => {
        methods.push(method);
        const spec = rpcCatalog.find((candidate) => candidate.name === method)!;
        const result = await executeCatalogRequest(spec, spec.requestSchema.parse(params), ports, ctx.principal);
        if (result.kind !== 'unary') throw new Error('Expected unary response');
        if ((result.statusCode ?? 200) >= 400) {
          const body = result.body as { code: string; message: string };
          throw new IpcRpcError({ code: -32000, message: body.message, data: result.body });
        }
        return result.body;
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process, 'cwd').mockReturnValue(directory);
      const program = new Command().name('coral-cli');
      registerSessionCommands(program, f.providers);
      await f.drive(program.parseAsync(['jobs', 'send', initial.jobId, '-i', 'second'], { from: 'user' }));
      const rendered = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(process.exitCode).toBe(1);
      expect(rendered).toContain('conversation_malformed');
      expect(rendered).toContain(cwd);
      expect(rendered).not.toMatch(/command=|coral-cli|safe to resend|Start a new/);
      if (ownerKind === 'workflow' || ownerKind === 'discussion')
        expect(rendered).toContain(`owning ${ownerKind} operation ${operationId}`);
      if (ownerKind === 'unknown') expect(rendered).toContain('Execution ownership is unknown');
      expect(methods).toEqual(['jobs.detail']);
      const request = {
        projectRoot,
        jobId: initial.jobId,
        input: 'second',
        clientMessageId: '33333333-3333-4333-8333-333333333334',
        target: {
          mode: 'continue' as const,
          execution: 1,
          requestedSeq: initial.requestedSeq,
          sourceEpoch: initial.epochKey,
        },
      };
      expect(await f.drive(rpc.jobs.send(request, ctx))).toMatchObject({
        state: 'refused',
        code: 'conversation_malformed',
      });
      if (ownerKind === 'provider-session' && facet === '{') {
        const steerRequest = { ...request, target: { ...request.target, mode: 'steer' as const } };
        const firstSteer = await f.drive(rpc.jobs.send(steerRequest, ctx));
        expect(firstSteer).toMatchObject({ state: 'unknown', conversationEvidenceFailure: true });
        expect(await f.drive(rpc.jobs.send(steerRequest, ctx))).toEqual(firstSteer);
      }
      const outside = canonicalWorkDirWireSchema.parse('/outside');
      expect(
        await f.drive(
          rpc.jobs.send(
            { ...request, projectRoot: outside },
            { ...ctx, projectRoot: outside, principal: testProjectPrincipal(outside) },
          ),
        ),
      ).toMatchObject({ state: 'refused', code: 'scope_mismatch' });
      expect(rpc.jobs.scopeCheck([initial.jobId], outside, 'contains')).toEqual({
        valid: [],
        missing: [],
        mismatch: [initial.jobId],
      });
      expect(services.size).toBe(0);
      expect(f.events(initial.jobId)).toEqual(before);
      expect(f.requests).toHaveLength(1);
    } finally {
      if (initialId !== undefined && savedFacet !== undefined)
        f.db
          .prepare('UPDATE projection_jobs SET facet = ?, execution_owner = ? WHERE job_id = ?')
          .run(savedFacet, savedOwner, initialId);
      vi.restoreAllMocks();
      await f.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each(['committed', 'unreadable'] as const)(
  'preserves prior delivery after a lost send response and facet corruption with %s replay evidence',
  async (replayEvidence) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coral-send-replay-corruption-')));
    const profile = join(directory, 'profile');
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
    const f = conversationIdentityFixture();
    const projectRoot = canonicalWorkDirWireSchema.parse(directory);
    f.runtime.storage.mkdirSync(projectRoot, { recursive: true });
    const ctx: InvocationContext = {
      ...f.ctx,
      projectRoot,
      principal: testProjectPrincipal(projectRoot),
      providerScope: {
        origin: 'caller',
        profiles: [{ provider: 'codex', profile: { canonicalLocation: profile, routing: { kind: 'home' } } }],
      },
    };
    const owner = f.serviceForContext(ctx);
    let jobId: string | undefined;
    let savedFacet: string | undefined;
    try {
      const initial = await f.drive(owner.start('codex', { prompt: 'first' }, ctx));
      if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
      jobId = initial.jobId;
      await f.drive(owner.waitForJobTerminal(jobId, 10_000));
      const { rpc } = routing(f);
      const ports = {
        identity: { pluginRoot: '/plugin' },
        coralEnvSnapshot: {},
        admin: { isLaunchFenceActive: () => false },
        jobs: rpc.jobs,
      } as unknown as HttpHandlerPorts;
      const envelopes: unknown[] = [];
      const outcomes: unknown[] = [];
      let committedHistory: ReturnType<typeof f.events> | undefined;
      ipc.request.mockImplementation(async (method: string, params: unknown) => {
        const spec = rpcCatalog.find((candidate) => candidate.name === method)!;
        const request = spec.requestSchema.parse(params);
        const result = await executeCatalogRequest(spec, request, ports, ctx.principal);
        if (result.kind !== 'unary') throw new Error('Expected unary response');
        if ((result.statusCode ?? 200) >= 400) {
          const body = result.body as { code: string; message: string };
          throw new IpcRpcError({ code: -32000, message: body.message, data: result.body });
        }
        if (method === 'jobs.send') {
          envelopes.push(request);
          outcomes.push(result.body);
          if (envelopes.length === 1) {
            expect(result.body).toMatchObject({ state: 'launched', launch: { execution: 2 } });
            await owner.waitForJobTerminal(initial.jobId, 10_000);
            committedHistory = f.events(initial.jobId);
            savedFacet = f.db
              .prepare<[string], { facet: string }>('SELECT facet FROM projection_jobs WHERE job_id = ?')
              .get(initial.jobId)!.facet;
            f.db.prepare('UPDATE projection_jobs SET facet = ? WHERE job_id = ?').run('{', initial.jobId);
            if (replayEvidence === 'unreadable')
              vi.spyOn(executionJournal, 'findCommittedExecutionRequest').mockImplementation(() => {
                throw new Error('Replay journal unavailable');
              });
            throw new Error('Committed send response lost');
          }
        }
        return result.body;
      });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.spyOn(process, 'cwd').mockReturnValue(directory);
      const program = new Command().name('coral-cli');
      registerSessionCommands(program, f.providers);
      await f.drive(program.parseAsync(['jobs', 'send', jobId, '-i', 'second'], { from: 'user' }));
      const rendered = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(process.exitCode).toBe(75);
      expect(envelopes).toHaveLength(2);
      expect(envelopes[1]).toEqual(envelopes[0]);
      expect(outcomes[1]).toMatchObject({ state: 'unknown', conversationEvidenceFailure: true });
      expect((outcomes[1] as { reason: string }).reason).toContain(`Execution owner: provider-session ${jobId}.`);
      expect(rendered).toContain(`Execution owner: provider-session ${jobId}.`);
      expect(rendered).toContain('This retry did not admit another execution or deliver input');
      expect(rendered).toMatch(/earlier (attempt|invocation) may have delivered/);
      expect(rendered).toContain(directory);
      expect(rendered).not.toMatch(/command=|coral-cli|safe to resend|Start a new/);
      expect(rendered).not.toContain('This attempt admitted no continuation and delivered no input');
      expect(f.events(jobId)).toEqual(committedHistory);
      expect(f.requests.map((request) => request.prompt)).toEqual(['first', 'second']);
    } finally {
      if (jobId !== undefined && savedFacet !== undefined)
        f.db.prepare('UPDATE projection_jobs SET facet = ? WHERE job_id = ?').run(savedFacet, jobId);
      vi.restoreAllMocks();
      await f.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

async function admittedRoutingFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'coral-send-read-budget-')));
  const profile = join(directory, 'profile');
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
  const f = conversationIdentityFixture();
  const projectRoot = canonicalWorkDirWireSchema.parse(directory);
  f.runtime.storage.mkdirSync(projectRoot, { recursive: true });
  const ctx: InvocationContext = {
    ...f.ctx,
    projectRoot,
    principal: testProjectPrincipal(projectRoot),
    providerScope: {
      origin: 'caller',
      profiles: [{ provider: 'codex', profile: { canonicalLocation: profile, routing: { kind: 'home' } } }],
    },
  };
  const owner = f.serviceForContext(ctx);
  const initial = await f.drive(owner.start('codex', { prompt: 'first' }, ctx));
  if (initial.status !== 'running' && initial.status !== 'queued') throw new Error(initial.message);
  await f.drive(owner.waitForJobTerminal(initial.jobId, 10_000));
  const { rpc } = routing(f);
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    admin: { isLaunchFenceActive: () => false },
    jobs: rpc.jobs,
  } as unknown as HttpHandlerPorts;
  const spec = rpcCatalog.find((candidate) => candidate.name === 'jobs.send')!;
  const request = {
    projectRoot,
    jobId: initial.jobId,
    input: 'second',
    clientMessageId: '55555555-5555-4555-8555-555555555555',
    providerScope: ctx.providerScope,
    target: {
      mode: 'continue',
      execution: 1,
      requestedSeq: initial.requestedSeq,
      sourceEpoch: initial.epochKey,
    },
  };
  return {
    f,
    owner,
    initial,
    ctx,
    request,
    issue: (input = request, principal = ctx.principal) =>
      f.drive(executeCatalogRequest(spec, spec.requestSchema.parse(input), ports, principal)),
    async dispose() {
      vi.restoreAllMocks();
      await f.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

type SendReadStage = 'address' | 'routing-projection' | 'send-status' | 'resume-status' | 'owner';

function busySendRead(
  h: Awaited<ReturnType<typeof admittedRoutingFixture>>,
  stage: SendReadStage,
  failures = 1,
  onRead?: (stage: SendReadStage) => void,
) {
  const prototype = Object.getPrototypeOf(h.f.db.prepare('SELECT 1')) as Statement;
  const original = prototype.get;
  let fullReads = 0;
  let failedReads = 0;
  const observations: { stage: SendReadStage; at: number }[] = [];
  const stages: SendReadStage[] = ['routing-projection', 'send-status', 'resume-status', 'owner'];
  vi.spyOn(prototype, 'get').mockImplementation(function (this: Statement, ...params) {
    const sql = this.sourceSQL.replace(/\s+/g, ' ').trim();
    if (params[0] !== h.initial.jobId || !sql.endsWith('FROM projection_jobs WHERE job_id = ?'))
      return original.apply(this, params);
    const observed = sql.startsWith('SELECT project_root, work_dir, job_kind, execution_owner')
      ? 'address'
      : sql.startsWith('SELECT job_id, execution_owner,')
        ? stages[fullReads]
        : undefined;
    if (observed === undefined) return original.apply(this, params);
    observations.push({ stage: observed, at: h.f.runtime.time.now() });
    onRead?.(observed);
    if (observed === stage && failedReads < failures) {
      failedReads++;
      throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    }
    const result = original.apply(this, params);
    if (observed !== 'address') fullReads++;
    return result;
  });
  return { observations, failedReads: () => failedReads };
}

it.each(['address', 'routing-projection', 'send-status', 'resume-status'] as const)(
  'retries a one-time SQLITE_BUSY at the actual RPC %s prerequisite without repeating admission',
  async (stage) => {
    const h = await admittedRoutingFixture();
    try {
      const reads = busySendRead(h, stage);
      const result = await h.issue();
      expect(result).toMatchObject({ kind: 'unary', body: { state: 'launched', launch: { execution: 2 } } });
      await h.f.drive(h.owner.waitForJobTerminal(h.initial.jobId, 10_000));
      expect(reads.failedReads()).toBe(1);
      expect(reads.observations.filter((read) => read.stage === stage)).toHaveLength(2);
      h.f.assertIdentity(h.initial.jobId, [1, 2]);
      expect(h.f.requests.map((request) => request.prompt)).toEqual(['first', 'second']);
    } finally {
      await h.dispose();
    }
  },
);

it.each(['address', 'routing-projection', 'send-status', 'resume-status'] as const)(
  'settles exhausted actual RPC %s prerequisites as uncertain without an admission or delivery',
  async (stage) => {
    const h = await admittedRoutingFixture();
    try {
      const before = h.f.events(h.initial.jobId);
      const reads = busySendRead(h, stage, Infinity);
      const result = await h.issue();
      expect(result).toMatchObject({
        kind: 'unary',
        body: { state: 'unknown', conversationEvidenceFailure: true },
      });
      if (result.kind !== 'unary') throw new Error('Expected unary response');
      const reason = (result.body as { reason: string }).reason;
      expect(reason).toContain('This attempt did not admit an execution or deliver input');
      expect(reason).toContain('An earlier attempt may have delivered this message');
      expect(reason).not.toMatch(/command=|coral-cli|safe to resend/);
      expect(reads.failedReads()).toBe(3);
      expect(h.f.events(h.initial.jobId)).toEqual(before);
      expect(h.f.requests).toHaveLength(1);
    } finally {
      await h.dispose();
    }
  },
);

it('checks caller scope after a retried RPC address read before decoding the conversation', async () => {
  const h = await admittedRoutingFixture();
  try {
    const reads = busySendRead(h, 'address');
    const unrelated = canonicalWorkDirWireSchema.parse(join(h.ctx.projectRoot, 'unrelated'));
    mkdirSync(unrelated);
    const result = await h.issue({ ...h.request, projectRoot: unrelated }, testProjectPrincipal(unrelated));
    expect(result).toMatchObject({ kind: 'unary', body: { state: 'refused', code: 'scope_mismatch' } });
    expect(reads.observations.map((read) => read.stage)).toEqual(['address', 'address']);
    expect(h.f.requests).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

it('preserves committed-request delivery uncertainty when a retried RPC projection cannot be read', async () => {
  const h = await admittedRoutingFixture();
  try {
    expect(await h.issue()).toMatchObject({ kind: 'unary', body: { state: 'launched' } });
    await h.f.drive(h.owner.waitForJobTerminal(h.initial.jobId, 10_000));
    const before = h.f.events(h.initial.jobId);
    const reads = busySendRead(h, 'routing-projection', Infinity);
    expect(await h.issue()).toMatchObject({
      kind: 'unary',
      body: {
        state: 'unknown',
        conversationEvidenceFailure: true,
        reason: expect.stringContaining('earlier attempt may have delivered'),
      },
    });
    expect(reads.failedReads()).toBe(3);
    expect(h.f.events(h.initial.jobId)).toEqual(before);
    expect(h.f.requests).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

it('does not read after the shared RPC admission deadline when prerequisite retry sleep overshoots', async () => {
  const h = await admittedRoutingFixture();
  try {
    const before = h.f.events(h.initial.jobId);
    const reads = busySendRead(h, 'address');
    const startedAt = h.f.runtime.time.now();
    vi.spyOn(h.f.runtime.time, 'sleep').mockImplementation(async () => h.f.runtime.time.tick(1_100));
    expect(await h.issue()).toMatchObject({ kind: 'unary', body: { state: 'unknown' } });
    expect(reads.observations).toEqual([{ stage: 'address', at: startedAt }]);
    expect(h.f.events(h.initial.jobId)).toEqual(before);
    expect(h.f.requests).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

it('shares the RPC deadline with the owner read instead of starting another retry window', async () => {
  const h = await admittedRoutingFixture();
  try {
    const before = h.f.events(h.initial.jobId);
    const reads = busySendRead(h, 'owner', Infinity, (stage) => {
      if (stage === 'resume-status') h.f.runtime.time.tick(850);
    });
    const startedAt = h.f.runtime.time.now();
    vi.spyOn(h.f.runtime.time, 'sleep').mockImplementation(async () => h.f.runtime.time.tick(200));
    expect(await h.issue()).toMatchObject({
      kind: 'unary',
      body: { state: 'refused', code: 'conversation_unobservable' },
    });
    expect(reads.observations.filter((read) => read.stage === 'owner')).toHaveLength(1);
    expect(reads.observations.every((read) => read.at < startedAt + 1_000)).toBe(true);
    expect(h.f.events(h.initial.jobId)).toEqual(before);
    expect(h.f.requests).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});

it('does not start the owner service read when routing observation has exhausted the shared deadline', async () => {
  const h = await admittedRoutingFixture();
  try {
    const before = h.f.events(h.initial.jobId);
    const reads = busySendRead(h, 'owner', Infinity, (stage) => {
      if (stage === 'routing-projection') h.f.runtime.time.tick(1_100);
    });
    expect(await h.issue()).toMatchObject({ kind: 'unary', body: { state: 'unknown' } });
    expect(reads.observations.map((read) => read.stage)).toEqual(['address', 'routing-projection']);
    expect(h.f.events(h.initial.jobId)).toEqual(before);
    expect(h.f.requests).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
