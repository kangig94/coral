import { describe, expect, it, vi } from 'vitest';

import { LaunchCoordinator } from '#src/coordinator/live/admission.js';
import { none } from '#src/providers/capability.js';
import { defineProvider, ProviderRegistry } from '#src/providers/registry.js';
import { jobsRegistry } from '#src/jobs/events.js';
import type { ProviderRequest } from '#src/providers/contract.js';
import { LaunchOrchestrator } from '#src/jobs/shell/launch.js';
import { JobStore } from '#src/jobs/store.js';
import { SessionManager } from '#src/sessions/shell.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { commit } from '#src/store/append.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers } from '#src/store/reducers.js';
import { sessionsRegistry } from '#src/sessions/events.js';
import { discussRegistry } from '#src/discuss/event-registry.js';
import { workflowPlanDeclaredEvent, workflowRegistry } from '#src/workflow/events.js';
import { buildWorkflowPlan } from '#src/workflow/plan.js';
import { parseExpression } from '#src/workflow/parser.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';
import { commitJobTerminal } from '#tests/helpers/job-commits.js';
import { fixtureProviderBindingCodec } from '#tests/helpers/provider-binding.js';
import { TEST_CODEX_BINDING, TEST_PROVIDER_SCOPE } from '#tests/helpers/provider-credentials.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { prepareFixtureExecutionContext } from '#tests/helpers/scripted-provider.js';

const PROJECT_ROOT = '/tmp/coral-workflow-replacement-atomicity';
const WORKFLOW_ID = 'workflow-replacement-atomicity';
const STALE_JOB_ID = `${WORKFLOW_ID}:0:0`;

describe('workflow replacement launch atomicity', () => {
  it('rolls back the claim, job, admission, and cache together and can recover by retrying', () => {
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db);
    const runtime = new SimulationRuntime();
    const reducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
    const bodyCodec = createEventBodyCodec();
    const coordinatorCommit = (cb: Parameters<typeof commit>[1]) =>
      commit(db, cb, {
        now: () => new Date(runtime.time.now()),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });
    const progressStore = new JobStore('test-ns', runtime, bodyCodec, {
      db,
      reducers,
      providers: permissiveProviderLookupPort,
    });
    const sessionManager = new SessionManager(PROJECT_ROOT, runtime, coordinatorCommit, undefined, db);
    const plan = buildWorkflowPlan(WORKFLOW_ID, parseExpression('architect@codex'));
    const slot = plan.slots[0];
    if (slot === undefined) throw new Error('expected workflow slot');

    coordinatorCommit((c) => {
      c.append(workflowPlanDeclaredEvent(WORKFLOW_ID, plan, TEST_PROVIDER_SCOPE));
      return undefined;
    });
    const session = sessionManager.allocate({
      binding: TEST_CODEX_BINDING,
      name: 'replacement-session',
      cwd: PROJECT_ROOT,
      projectRoot: PROJECT_ROOT,
      backendNamespace: 'test-ns',
      retention: 'retain',
    });
    expect(sessionManager.claimForJobSync(session.sessionId, STALE_JOB_ID)).toBe(true);
    progressStore.appendLaunchRequested(STALE_JOB_ID, {
      jobId: STALE_JOB_ID,
      owner: { kind: 'workflow', id: WORKFLOW_ID },
      sessionId: session.sessionId,
      provider: 'codex',
      projectRoot: PROJECT_ROOT,
      backendNamespace: 'test-ns',
      jobKind: 'provider',
      pool: 'default',
      enqueueSequence: progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      parentWorkflowJobId: WORKFLOW_ID,
      workflowSlotId: slot.slotId,
      workflowSlotGeneration: 0,
      request: { prompt: 'first', cwd: PROJECT_ROOT, bypassPermissions: false, coralEnv: {} },
      createdAt: new Date(runtime.time.now()).toISOString(),
    });
    commitJobTerminal(progressStore, STALE_JOB_ID, session.sessionId, {
      content: '',
      outcome: { kind: 'aborted', reason: 'user_abort' },
      durationMs: 0,
    });
    sessionManager.releaseJob(session.sessionId, STALE_JOB_ID);
    sessionManager.recordContinuationLease({
      sessionId: session.sessionId,
      jobId: STALE_JOB_ID,
      workflowId: WORKFLOW_ID,
      workflowSlotId: slot.slotId,
      replacementGeneration: 1,
      reason: 'stale_recovery',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const pending = sessionManager.get('codex', session.sessionId);
    if (pending === null) throw new Error('expected pending provider session');
    const eventCountBefore = (
      db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM events').get() as { count: number }
    ).count;

    const launchAdmission = new LaunchCoordinator({ runtime });
    const registeredJobs = new Set<string>();
    const abortRegistry = {
      register: vi.fn((jobId: string) => registeredJobs.add(jobId)),
      getSignal: vi.fn(() => undefined),
      remove: vi.fn((jobId: string) => registeredJobs.delete(jobId)),
    };
    const jobPools = new Map();
    const providerRegistry = new ProviderRegistry();
    const provider = defineProvider({
      name: 'codex',
      run: async function* noop() {},
      prepareExecutionContext: prepareFixtureExecutionContext,
    })
      .binding(fixtureProviderBindingCodec('codex'))
      .artifacts(none('atomicity fixture has no artifacts'))
      .build();
    providerRegistry.register(provider);
    const boundProviderResult = providerRegistry.rehydrateBinding(TEST_CODEX_BINDING);
    if (!boundProviderResult.ok) throw new Error('expected fixture provider binding');
    const boundProvider = boundProviderResult.value;
    const orchestrator = new LaunchOrchestrator({
      abortRegistry: abortRegistry as never,
      progressStore,
      sessionManager,
      launchAdmission,
      durableSpawner: {} as never,
      providerRegistry,
      runtime,
      coordinatorCommit,
      backendNamespace: 'test-ns',
      bundleHash: 'test-bundle',
      jobPools,
      terminalMaterializer: { recordProviderTerminal: vi.fn() },
      acquireServer: vi.fn(async () => {
        throw new Error('provider execution is outside this atomicity test');
      }),
    });
    const request: ProviderRequest = {
      action: 'resume',
      sessionId: session.sessionId,
      prompt: 'replacement',
      cwd: PROJECT_ROOT,
      bypassPermissions: false,
      coralEnv: {},
    };
    const replacementOptions = {
      owner: { kind: 'workflow' as const, id: WORKFLOW_ID },
      parentWorkflowJobId: WORKFLOW_ID,
      workflowSlotId: slot.slotId,
      workflowSlotGeneration: 1,
      replacesWorkflowJobId: STALE_JOB_ID,
      projectRoot: PROJECT_ROOT,
      mintProtectedEnv: () => ({}),
    };

    db.exec(`CREATE TRIGGER fail_replacement_admission
      BEFORE INSERT ON events
      WHEN NEW.type = 'job.queue.admitted'
      BEGIN
        SELECT RAISE(ABORT, 'forced replacement admission failure');
      END`);
    try {
      expect(() => orchestrator.launchWorkflowReplacement(boundProvider, pending, request, replacementOptions)).toThrow(
        'forced replacement admission failure',
      );

      expect(db.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: eventCountBefore });
      expect(db.prepare('SELECT COUNT(*) AS count FROM projection_jobs WHERE job_id != ?').get(STALE_JOB_ID)).toEqual({
        count: 0,
      });
      expect(launchAdmission.getActiveJobIds()).toEqual([]);
      expect(jobPools.size).toBe(0);
      expect(registeredJobs.size).toBe(0);
      const rolledBack = sessionManager.get('codex', session.sessionId);
      expect(rolledBack).toMatchObject({
        version: pending.version,
        continuationLease: { status: 'pending', staleJobId: STALE_JOB_ID },
      });
      expect(rolledBack?.activeJobId).toBeUndefined();

      db.exec('DROP TRIGGER fail_replacement_admission');
      const retrySession = sessionManager.get('codex', session.sessionId);
      if (retrySession === null) throw new Error('expected retryable provider session');
      const recovered = orchestrator.launchWorkflowReplacement(
        boundProvider,
        retrySession,
        request,
        replacementOptions,
      );
      expect(recovered).toMatchObject({ kind: 'provider-session', status: 'running', sessionId: session.sessionId });
      if (recovered.status !== 'running') throw new Error('expected recovered replacement launch');
      expect(progressStore.readLaunchProjection(recovered.jobId)).toMatchObject({
        owner: { kind: 'workflow', id: WORKFLOW_ID },
        workflowSlotGeneration: 1,
        replacesWorkflowJobId: STALE_JOB_ID,
      });
      expect(sessionManager.get('codex', session.sessionId)).toMatchObject({
        activeJobId: recovered.jobId,
        continuationLease: { status: 'claimed', resumedJobId: recovered.jobId },
      });
      expect(registeredJobs).toEqual(new Set([recovered.jobId]));
    } finally {
      db.close();
    }
  });
});
