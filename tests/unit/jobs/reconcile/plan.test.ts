import { describe, expect, it } from 'vitest';
import type {
  JobLaunch,
  JobRuntime,
  JobStatus,
  JobTerminal,
  ProviderJobLaunch,
  WorkflowJobLaunch,
} from '#src/jobs/records.js';
import type { DurableCliRuntimeRecord, DurableProcessExit } from '#src/runtime/durable-runtime.js';
import type { ProviderSession } from '#src/sessions/entry.js';
import {
  type RecoveryProjectionSnapshot,
  type RecoveryAction,
  type RecoveryJobFacts,
  planRecovery,
} from '#src/jobs/reconcile/plan.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';

const NOW = '2026-04-12T00:00:00.000Z';
const CURRENT_NAMESPACE = 'namespace-current';

type JobFixture = {
  jobId: string;
  status?: JobStatus | null;
  launch?: JobLaunch | null;
  runtime?: JobRuntime | null;
  exit?: DurableProcessExit | null;
  terminalPayload?: JobTerminal | null;
  hasLaunchRequest?: boolean;
  hasRuntimeStart?: boolean;
  hasTerminalRecord?: boolean;
  includeInJobIds?: boolean;
};

type SessionFixture = {
  scopeKey?: string;
  sessionId: string;
  provider: string;
  activeJobId?: string;
  entry?: ProviderSession | null;
};

type StoredJob = {
  hasLaunchRequest: boolean;
  hasRuntimeStart: boolean;
  hasTerminalRecord: boolean;
  status: JobStatus | null;
  launch: JobLaunch | null;
  runtime: JobRuntime | null;
  exit: DurableProcessExit | null;
  terminalPayload: JobTerminal | null;
};

class InMemoryRecoverySnapshot implements RecoveryProjectionSnapshot {
  readonly jobIds: string[] = [];
  readonly currentNamespace: string;
  private readonly jobs = new Map<string, StoredJob>();
  private readonly sessionRefs: Array<{ sessionId: string; provider: string }> = [];
  private readonly sessions = new Map<string, ProviderSession | null>();

  constructor(currentNamespace = CURRENT_NAMESPACE) {
    this.currentNamespace = currentNamespace;
  }

  isPidAlive(): boolean {
    return true;
  }

  addJob(fixture: JobFixture): this {
    this.jobs.set(fixture.jobId, {
      hasLaunchRequest: fixture.hasLaunchRequest ?? (fixture.launch !== undefined && fixture.launch !== null),
      hasRuntimeStart: fixture.hasRuntimeStart ?? (fixture.runtime !== undefined && fixture.runtime !== null),
      hasTerminalRecord: fixture.hasTerminalRecord ?? (fixture.exit !== undefined && fixture.exit !== null),
      status: fixture.status ?? null,
      launch: fixture.launch ?? null,
      runtime: fixture.runtime ?? null,
      exit: fixture.exit ?? null,
      terminalPayload: fixture.terminalPayload ?? null,
    });

    if (fixture.includeInJobIds !== false && !this.jobIds.includes(fixture.jobId)) {
      this.jobIds.push(fixture.jobId);
    }

    return this;
  }

  addSession(fixture: SessionFixture): this {
    this.sessionRefs.push({
      sessionId: fixture.sessionId,
      provider: fixture.provider,
    });

    const entry =
      fixture.entry === undefined
        ? makeSession({
            sessionId: fixture.sessionId,
            binding: {
              provider: fixture.provider,
              kind: 'account',
              binding: { fixture: fixture.provider },
            },
            activeJobId: fixture.activeJobId,
          })
        : fixture.entry;

    this.sessions.set(fixture.sessionId, entry);
    return this;
  }

  readJob(jobId: string): RecoveryJobFacts {
    const job = this.jobs.get(jobId);
    return {
      jobId,
      hasLaunchRequest: job?.hasLaunchRequest ?? false,
      hasRuntimeStart: job?.hasRuntimeStart ?? false,
      hasTerminalRecord: job?.hasTerminalRecord ?? false,
      status: job?.status ?? null,
      launchRecord: job?.launch ?? null,
      runtimeRecord: job?.runtime ?? null,
    };
  }

  listSessionRefs(): Array<{ sessionId: string; provider: string }> {
    return this.sessionRefs.map((ref) => ({ ...ref }));
  }

  readSession(sessionId: string): ProviderSession | null {
    return this.sessions.get(sessionId) ?? null;
  }
}

function makeStatus(jobId: string, phase: JobStatus['phase'], overrides: Partial<JobStatus> = {}): JobStatus {
  const base: JobStatus = {
    jobId,
    owner: { kind: 'provider-session', id: `${jobId}-session` },
    sessionId: `${jobId}-session`,
    provider: 'fakeprovider',
    projectRoot: `/projects/${jobId}`,
    workDir: fixtureCanonicalWorkDir(`/projects/${jobId}`),
    backendNamespace: CURRENT_NAMESPACE,
    jobKind: 'provider',
    phase,
    updatedAt: NOW,
  };

  return {
    ...base,
    ...overrides,
  };
}

function makeLaunch(
  jobId: string,
  overrides: Partial<ProviderJobLaunch> & {
    request?: Partial<ProviderJobLaunch['request']>;
  } = {},
): ProviderJobLaunch {
  const base: ProviderJobLaunch = {
    jobId,
    owner: { kind: 'provider-session', id: `${jobId}-session` },
    sessionId: `${jobId}-session`,
    provider: 'fakeprovider',
    projectRoot: `/projects/${jobId}`,
    backendNamespace: CURRENT_NAMESPACE,
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: `prompt-${jobId}`,
      cwd: `/projects/${jobId}`,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW,
  };

  return {
    ...base,
    ...overrides,
    request: {
      ...base.request,
      ...overrides.request,
      coralEnv: {
        ...base.request.coralEnv,
        ...(overrides.request?.coralEnv ?? {}),
      },
    },
  };
}

function makeWorkflowLaunch(jobId: string): WorkflowJobLaunch {
  return {
    jobId,
    owner: { kind: 'workflow', id: jobId },
    sessionId: null,
    provider: null,
    projectRoot: `/projects/${jobId}`,
    backendNamespace: CURRENT_NAMESPACE,
    jobKind: 'workflow',
    pool: 'default',
    enqueueSequence: 0,
    request: {
      prompt: `workflow-${jobId}`,
      cwd: `/projects/${jobId}`,
      bypassPermissions: false,
      coralEnv: {},
    },
    createdAt: NOW,
  };
}

function makeRuntime(jobId: string, overrides: Partial<DurableCliRuntimeRecord> = {}): DurableCliRuntimeRecord {
  return {
    transport: 'durable-cli',
    pid: 1000,
    stdoutPath: `/tmp/${jobId}.stdout`,
    stderrPath: `/tmp/${jobId}.stderr`,
    startTime: NOW,
    ...overrides,
  };
}

function makeExit(overrides: Partial<DurableProcessExit> = {}): DurableProcessExit {
  return {
    exitCode: 0,
    signal: null,
    endTime: NOW,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  const sessionId = overrides.sessionId ?? 'session';

  return {
    ...overrides,
    sessionId,
    binding: overrides.binding ?? {
      provider: 'fakeprovider',
      kind: 'account',
      binding: { fixture: 'fakeprovider' },
    },
    name: overrides.name ?? `${sessionId}-name`,
    state: overrides.state ?? 'ready',
    retention: overrides.retention ?? 'retain',
    artifactHandles: overrides.artifactHandles ?? [],
    retentionDiscard: overrides.retentionDiscard ?? { attempts: [] },
    cwd: overrides.cwd ?? '/workspace',
    projectRoot: overrides.projectRoot ?? '/workspace',
    backendNamespace: overrides.backendNamespace ?? 'test-ns',
    providerContinuity: overrides.providerContinuity ?? null,
    createdAt: overrides.createdAt ?? NOW,
    lastUsedAt: overrides.lastUsedAt ?? NOW,
    version: overrides.version ?? 1,
  };
}

function summarizeActions(actions: RecoveryAction[]) {
  return actions.map((action) => {
    switch (action.type) {
      case 'registerQueued':
        return {
          type: action.type,
          jobId: action.jobId,
          enqueueSequence: action.launchRecord.enqueueSequence,
        };
      case 'registerRunning':
        return {
          type: action.type,
          jobId: action.jobId,
          transport: action.runtimeRecord.transport ?? 'durable-cli',
        };
      case 'markError':
        return {
          type: action.type,
          jobId: action.jobId,
          fault: action.fault.kind,
        };
      case 'resolvePreReadyLaunch':
        return {
          type: action.type,
          jobId: action.jobId,
        };
      case 'releaseSessionClaim':
        return {
          type: action.type,
          sessionId: action.sessionId,
          jobId: action.jobId,
        };
      default:
        return action;
    }
  });
}

describe('planRecovery', () => {
  it('returns markError with missing_launch_record for live jobs missing launch records', () => {
    const status = makeStatus('missing-launch-job', 'launching');
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'missing-launch-job',
      status,
      hasLaunchRequest: false,
    });

    const plan = planRecovery(snapshot);
    expect(plan.register).toEqual([]);
    expect(plan.cleanup).toEqual([
      {
        type: 'markError',
        jobId: 'missing-launch-job',
        fault: { kind: 'missing_launch_record' },
        status,
      },
    ]);
  });

  it('leaves same-namespace live workflow parent jobs for workflow recovery', () => {
    const missingLaunchStatus = makeStatus('workflow-missing-launch', 'running', {
      jobKind: 'workflow',
    });
    const runningStatus = makeStatus('workflow-running', 'running', {
      jobKind: 'workflow',
    });
    const queuedStatus = makeStatus('workflow-queued', 'queued', {
      jobKind: 'workflow',
    });
    const snapshot = new InMemoryRecoverySnapshot()
      .addJob({
        jobId: 'workflow-missing-launch',
        status: missingLaunchStatus,
        hasLaunchRequest: false,
      })
      .addJob({
        jobId: 'workflow-running',
        status: runningStatus,
        launch: makeWorkflowLaunch('workflow-running'),
        runtime: { transport: 'workflow', startTime: NOW },
        hasLaunchRequest: true,
        hasRuntimeStart: true,
      })
      .addJob({
        jobId: 'workflow-queued',
        status: queuedStatus,
        launch: makeWorkflowLaunch('workflow-queued'),
        hasLaunchRequest: true,
        hasRuntimeStart: false,
      });

    const plan = planRecovery(snapshot);
    expect(plan.register).toEqual([]);
    expect(plan.cleanup).toEqual([]);
  });

  it('returns releaseSessionClaim for orphaned active job claims', () => {
    const snapshot = new InMemoryRecoverySnapshot().addSession({
      scopeKey: '/sessions/a',
      sessionId: 'orphan-claim',
      provider: 'fakeprovider',
      activeJobId: 'missing-job',
    });

    const plan = planRecovery(snapshot);
    expect(plan.register).toEqual([]);
    expect(plan.cleanup).toEqual([
      {
        type: 'releaseSessionClaim',
        sessionId: 'orphan-claim',
        jobId: 'missing-job',
      },
    ]);
  });

  it('orders actions by registration bridge contract', () => {
    const runningSecondLaunch = makeLaunch('running-second', { enqueueSequence: 30 });
    const runningSecondRuntime = makeRuntime('running-second', { pid: 4001 });
    const queuedLateLaunch = makeLaunch('queued-late', { enqueueSequence: 9 });
    const queuedEarlyLaunch = makeLaunch('queued-early', { enqueueSequence: 1 });
    const runningFirstLaunch = makeLaunch('running-first', { enqueueSequence: 40 });
    const runningFirstRuntime = makeRuntime('running-first', { pid: 4002 });
    const staleDeadLaunch = makeLaunch('stale-dead', { enqueueSequence: 50 });
    const staleDeadRuntime = makeRuntime('stale-dead', { pid: 4003 });

    const plan = planRecovery(
      new InMemoryRecoverySnapshot()
        .addJob({
          jobId: 'running-second',
          status: makeStatus('running-second', 'running'),
          launch: runningSecondLaunch,
          runtime: runningSecondRuntime,
          hasLaunchRequest: true,
          hasRuntimeStart: true,
        })
        .addJob({
          jobId: 'incomplete',
          status: null,
          launch: makeLaunch('incomplete'),
          hasLaunchRequest: true,
        })
        .addJob({
          jobId: 'missing-launch',
          status: makeStatus('missing-launch', 'launching'),
          hasLaunchRequest: false,
        })
        .addJob({
          jobId: 'queued-late',
          status: makeStatus('queued-late', 'queued'),
          launch: queuedLateLaunch,
          hasLaunchRequest: true,
          hasRuntimeStart: false,
        })
        .addJob({
          jobId: 'ghost',
          status: makeStatus('ghost', 'running'),
          launch: makeLaunch('ghost'),
          hasLaunchRequest: true,
          hasRuntimeStart: false,
        })
        .addJob({
          jobId: 'queued-early',
          status: makeStatus('queued-early', 'queued'),
          launch: queuedEarlyLaunch,
          hasLaunchRequest: true,
          hasRuntimeStart: false,
        })
        .addJob({
          jobId: 'running-first',
          status: makeStatus('running-first', 'launching'),
          launch: runningFirstLaunch,
          runtime: runningFirstRuntime,
          hasLaunchRequest: true,
          hasRuntimeStart: true,
        })
        .addJob({
          jobId: 'terminal',
          status: makeStatus('terminal', 'completed'),
        })
        .addJob({
          jobId: 'stale-dead',
          status: makeStatus('stale-dead', 'running'),
          launch: staleDeadLaunch,
          runtime: staleDeadRuntime,
          exit: makeExit({ exitCode: 1 }),
          hasLaunchRequest: true,
          hasRuntimeStart: true,
          hasTerminalRecord: true,
        })
        .addSession({
          scopeKey: '/sessions/order',
          sessionId: 'terminal-claim',
          provider: 'fakeprovider',
          activeJobId: 'terminal',
        })
        .addSession({
          scopeKey: '/sessions/order',
          sessionId: 'orphan-claim',
          provider: 'fakeprovider',
          activeJobId: 'missing-job',
        }),
    );

    expect(summarizeActions(plan.register)).toEqual([
      { type: 'registerRunning', jobId: 'running-second', transport: 'durable-cli' },
      { type: 'registerRunning', jobId: 'running-first', transport: 'durable-cli' },
      { type: 'registerRunning', jobId: 'stale-dead', transport: 'durable-cli' },
      { type: 'registerQueued', jobId: 'queued-early', enqueueSequence: 1 },
      { type: 'registerQueued', jobId: 'queued-late', enqueueSequence: 9 },
    ]);
    expect(summarizeActions(plan.cleanup)).toEqual([
      { type: 'discardIncompleteAdmission', jobId: 'incomplete' },
      { type: 'markError', jobId: 'missing-launch', fault: 'missing_launch_record' },
      { type: 'resolvePreReadyLaunch', jobId: 'ghost' },
      {
        type: 'releaseSessionClaim',
        sessionId: 'terminal-claim',
        jobId: 'terminal',
      },
      {
        type: 'releaseSessionClaim',
        sessionId: 'orphan-claim',
        jobId: 'missing-job',
      },
    ]);
  });
});
