import { describe, expect, it } from 'vitest'
import type { JobLaunch, JobRuntime, JobStatus, JobTerminal } from '#src/jobs/records.js';
import type { DurableProcessExit } from '#src/runtime/durable-runtime.js';
import type { SessionEntry } from '#src/sessions/entry.js';
import type { RecoveryProjectionSnapshot, RecoveryAction, RecoveryJobFacts } from '#src/jobs/reconcile/plan.js'
import { planRecovery } from '#src/jobs/reconcile/plan.js'

const NOW = '2026-04-12T00:00:00.000Z'
const CURRENT_NAMESPACE = 'namespace-current'
const FOREIGN_NAMESPACE = 'namespace-foreign'

type JobFixture = {
  jobId: string
  status?: JobStatus | null
  launch?: JobLaunch | null
  runtime?: JobRuntime | null
  exit?: DurableProcessExit | null
  terminalPayload?: JobTerminal | null
  hasLaunchRequest?: boolean
  hasRuntimeStart?: boolean
  hasTerminalRecord?: boolean
  includeInJobIds?: boolean
}

type SessionFixture = {
  scopeKey?: string
  sessionId: string
  provider: string
  activeJobId?: string
  entry?: SessionEntry | null
}

type StoredJob = {
  hasLaunchRequest: boolean
  hasRuntimeStart: boolean
  hasTerminalRecord: boolean
  status: JobStatus | null
  launch: JobLaunch | null
  runtime: JobRuntime | null
  exit: DurableProcessExit | null
  terminalPayload: JobTerminal | null
}

class InMemoryRecoverySnapshot implements RecoveryProjectionSnapshot {
  readonly jobIds: string[] = []
  readonly currentNamespace: string
  private readonly jobs = new Map<string, StoredJob>()
  private readonly sessionRefs: Array<{ sessionId: string; provider: string }> = []
  private readonly sessions = new Map<string, SessionEntry | null>()

  constructor(currentNamespace = CURRENT_NAMESPACE) {
    this.currentNamespace = currentNamespace
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
    })

    if (fixture.includeInJobIds !== false && !this.jobIds.includes(fixture.jobId)) {
      this.jobIds.push(fixture.jobId)
    }

    return this
  }

  addSession(fixture: SessionFixture): this {
    this.sessionRefs.push({
      sessionId: fixture.sessionId,
      provider: fixture.provider,
    })

    const entry =
      fixture.entry === undefined
        ? makeSession({
            sessionId: fixture.sessionId,
            provider: fixture.provider,
            activeJobId: fixture.activeJobId,
          })
        : fixture.entry

    this.sessions.set(fixture.sessionId, entry)
    return this
  }

  readJob(jobId: string): RecoveryJobFacts {
    const job = this.jobs.get(jobId)
    return {
      jobId,
      hasLaunchRequest: job?.hasLaunchRequest ?? false,
      hasRuntimeStart: job?.hasRuntimeStart ?? false,
      hasTerminalRecord: job?.hasTerminalRecord ?? false,
      status: job?.status ?? null,
      launchRecord: job?.launch ?? null,
      runtimeRecord: job?.runtime ?? null,
    }
  }

  listSessionRefs(): Array<{ sessionId: string; provider: string }> {
    return this.sessionRefs.map((ref) => ({ ...ref }))
  }

  readSession(sessionId: string): SessionEntry | null {
    return this.sessions.get(sessionId) ?? null
  }
}

function makeStatus(
  jobId: string,
  phase: JobStatus['phase'],
  overrides: Partial<JobStatus> = {},
): JobStatus {
  const base: JobStatus = {
    jobId,
    sessionId: `${jobId}-session`,
    provider: 'fakeprovider',
    projectRoot: `/projects/${jobId}`,
    backendNamespace: CURRENT_NAMESPACE,
    jobKind: 'provider',
    phase,
    updatedAt: NOW,
  }

  return {
    ...base,
    ...overrides,
  }
}

function makeLaunch(
  jobId: string,
  overrides: Partial<JobLaunch> & {
    request?: Partial<JobLaunch['request']>
  } = {},
): JobLaunch {
  const base: JobLaunch = {
    jobId,
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
  }

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
  }
}

function makeRuntime(jobId: string, overrides: Partial<JobRuntime> = {}): JobRuntime {
  return {
    pid: 1000,
    stdoutPath: `/tmp/${jobId}.stdout`,
    stderrPath: `/tmp/${jobId}.stderr`,
    startTime: NOW,
    ...overrides,
  } as JobRuntime
}

function makeAppServerRuntime(overrides: Partial<JobRuntime> = {}): JobRuntime {
  return {
    transport: 'app-server',
    startTime: NOW,
    providerMeta: {
      provider: 'fakeprovider',
      leaseState: 'acquired',
      recoveryPolicy: 'session_continuity_only',
    },
    ...overrides,
  } as JobRuntime
}

function makeExit(overrides: Partial<DurableProcessExit> = {}): DurableProcessExit {
  return {
    exitCode: 0,
    signal: null,
    endTime: NOW,
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  const sessionId = overrides.sessionId ?? 'session'
  const provider = overrides.provider ?? 'fakeprovider'

  return {
    ...overrides,
    sessionId,
    provider,
    name: overrides.name ?? `${sessionId}-name`,
    state: overrides.state ?? 'ready',
    cwd: overrides.cwd ?? '/workspace',
    projectRoot: overrides.projectRoot ?? '/workspace',
    backendNamespace: overrides.backendNamespace ?? 'test-ns',
    createdAt: overrides.createdAt ?? NOW,
    lastUsedAt: overrides.lastUsedAt ?? NOW,
    version: overrides.version ?? 1,
  }
}

function summarizeActions(actions: RecoveryAction[]) {
  return actions.map((action) => {
    switch (action.type) {
      case 'registerQueued':
        return {
          type: action.type,
          jobId: action.jobId,
          enqueueSequence: action.launchRecord.enqueueSequence,
        }
      case 'registerRunning':
        return {
          type: action.type,
          jobId: action.jobId,
          transport: action.runtimeRecord.transport ?? 'durable-cli',
        }
      case 'markError':
        return {
          type: action.type,
          jobId: action.jobId,
          fault: action.fault.kind,
        }
      case 'releaseSessionClaim':
        return {
          type: action.type,
          sessionId: action.sessionId,
          jobId: action.jobId,
        }
      default:
        return action
    }
  })
}

describe('planRecovery', () => {
  it('returns discardIncompleteAdmission for incomplete admission', () => {
    const snapshot = new InMemoryRecoverySnapshot()
      .addJob({
        jobId: 'incomplete-job',
        status: null,
        launch: makeLaunch('incomplete-job'),
        hasLaunchRequest: true,
      })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      { type: 'discardIncompleteAdmission', jobId: 'incomplete-job' },
    ])
  })

  it('returns markError with missing_launch_record for live jobs missing launch records', () => {
    const status = makeStatus('missing-launch-job', 'launching')
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'missing-launch-job',
      status,
      hasLaunchRequest: false,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'markError',
        jobId: 'missing-launch-job',
        fault: { kind: 'missing_launch_record' },
        status,
      },
    ])
  })

  it('returns markError with ghost_launch for stale_running jobs', () => {
    const status = makeStatus('ghost-job', 'running')
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'ghost-job',
      status,
      launch: makeLaunch('ghost-job'),
      hasLaunchRequest: true,
      hasRuntimeStart: false,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'markError',
        jobId: 'ghost-job',
        fault: { kind: 'ghost_launch' },
        status,
      },
    ])
  })

  it('marks live internal KB jobs as wrapper_lost instead of provider recovery', () => {
    const status = makeStatus('kb-reindex-job', 'running', {
      sessionId: null,
      provider: null,
      jobKind: 'kb',
    })
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'kb-reindex-job',
      status,
      hasLaunchRequest: true,
      hasRuntimeStart: true,
      runtime: {
        transport: 'internal',
        operation: 'kb.reindex',
        startTime: NOW,
      },
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'markError',
        jobId: 'kb-reindex-job',
        fault: { kind: 'wrapper_lost' },
        status,
      },
    ])
  })

  it('returns registerQueued for queued recoverable jobs', () => {
    const launchRecord = makeLaunch('queued-job', { enqueueSequence: 7 })
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'queued-job',
      status: makeStatus('queued-job', 'queued'),
      launch: launchRecord,
      hasLaunchRequest: true,
      hasRuntimeStart: false,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([
      {
        type: 'registerQueued',
        jobId: 'queued-job',
        launchRecord,
      },
    ])
    expect(plan.cleanup).toEqual([])
  })

  it('returns registerRunning for running recoverable jobs', () => {
    const launchRecord = makeLaunch('running-job')
    const runtimeRecord = makeRuntime('running-job', { pid: 2001 })
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'running-job',
      status: makeStatus('running-job', 'running'),
      launch: launchRecord,
      runtime: runtimeRecord,
      hasLaunchRequest: true,
      hasRuntimeStart: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([
      {
        type: 'registerRunning',
        jobId: 'running-job',
        launchRecord,
        runtimeRecord,
      },
    ])
    expect(plan.cleanup).toEqual([])
  })

  it('returns registerRunning for stale_dead jobs', () => {
    const launchRecord = makeLaunch('stale-dead-job')
    const runtimeRecord = makeRuntime('stale-dead-job', { pid: 2002 })
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'stale-dead-job',
      status: makeStatus('stale-dead-job', 'launching'),
      launch: launchRecord,
      runtime: runtimeRecord,
      exit: makeExit({ exitCode: 1 }),
      hasLaunchRequest: true,
      hasRuntimeStart: true,
      hasTerminalRecord: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([
      {
        type: 'registerRunning',
        jobId: 'stale-dead-job',
        launchRecord,
        runtimeRecord,
      },
    ])
    expect(plan.cleanup).toEqual([])
  })

  it('returns no action for terminal jobs', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'terminal-job',
      status: makeStatus('terminal-job', 'completed'),
      launch: makeLaunch('terminal-job'),
      runtime: makeRuntime('terminal-job'),
      hasLaunchRequest: true,
      hasRuntimeStart: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([])
  })

  it('returns no action for foreign-namespace jobs', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'foreign-job',
      status: makeStatus('foreign-job', 'running', { backendNamespace: FOREIGN_NAMESPACE }),
      launch: makeLaunch('foreign-job', { backendNamespace: FOREIGN_NAMESPACE }),
      runtime: makeRuntime('foreign-job'),
      hasLaunchRequest: true,
      hasRuntimeStart: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([])
  })

  it('returns registerRunning for app-server runtimes', () => {
    const launchRecord = makeLaunch('app-server-job')
    const runtimeRecord = makeAppServerRuntime()
    const plan = planRecovery(
      new InMemoryRecoverySnapshot().addJob({
        jobId: 'app-server-job',
        status: makeStatus('app-server-job', 'running'),
        launch: launchRecord,
        runtime: runtimeRecord,
        hasLaunchRequest: true,
        hasRuntimeStart: true,
      }),
    )

    expect(plan.register[0]).toEqual({
      type: 'registerRunning',
      jobId: 'app-server-job',
      launchRecord,
      runtimeRecord,
    })
    expect(plan.cleanup).toEqual([])
  })

  it('returns releaseSessionClaim for terminal active job claims', () => {
    const snapshot = new InMemoryRecoverySnapshot()
      .addJob({
        jobId: 'terminal-claimed-job',
        status: makeStatus('terminal-claimed-job', 'error'),
      })
      .addSession({
        scopeKey: '/sessions/a',
        sessionId: 'terminal-claim',
        provider: 'fakeprovider',
        activeJobId: 'terminal-claimed-job',
      })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'releaseSessionClaim',
        sessionId: 'terminal-claim',
        jobId: 'terminal-claimed-job',
      },
    ])
  })

  it('returns releaseSessionClaim for orphaned active job claims', () => {
    const snapshot = new InMemoryRecoverySnapshot().addSession({
      scopeKey: '/sessions/a',
      sessionId: 'orphan-claim',
      provider: 'fakeprovider',
      activeJobId: 'missing-job',
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'releaseSessionClaim',
        sessionId: 'orphan-claim',
        jobId: 'missing-job',
      },
    ])
  })

  it('releases foreign-namespace terminal session claims without mutating the foreign job', () => {
    const snapshot = new InMemoryRecoverySnapshot()
      .addJob({
        jobId: 'foreign-terminal-job',
        status: makeStatus('foreign-terminal-job', 'completed', { backendNamespace: FOREIGN_NAMESPACE }),
      })
      .addSession({
        scopeKey: '/sessions/foreign',
        sessionId: 'foreign-terminal-claim',
        provider: 'fakeprovider',
        activeJobId: 'foreign-terminal-job',
      })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'releaseSessionClaim',
        sessionId: 'foreign-terminal-claim',
        jobId: 'foreign-terminal-job',
      },
    ])
  })

  it('does not release session claims for live jobs that still exist', () => {
    const snapshot = new InMemoryRecoverySnapshot()
      .addJob({
        jobId: 'live-job',
        status: makeStatus('live-job', 'running'),
        launch: makeLaunch('live-job'),
        runtime: makeRuntime('live-job'),
        hasLaunchRequest: true,
        hasRuntimeStart: true,
      })
      .addSession({
        scopeKey: '/sessions/live',
        sessionId: 'live-claim',
        provider: 'fakeprovider',
        activeJobId: 'live-job',
      })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([
      {
        type: 'registerRunning',
        jobId: 'live-job',
        launchRecord: makeLaunch('live-job'),
        runtimeRecord: makeRuntime('live-job'),
      },
    ])
    expect(plan.cleanup).toEqual([])
  })

  it('treats a missing status projection as incomplete admission when launch exists', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'corrupt-status-job',
      status: null,
      launch: makeLaunch('corrupt-status-job'),
      hasLaunchRequest: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      { type: 'discardIncompleteAdmission', jobId: 'corrupt-status-job' },
    ])
  })

  it('suppresses queued recovery when the launch projection is unavailable', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'corrupt-launch-job',
      status: makeStatus('corrupt-launch-job', 'queued'),
      launch: null,
      hasLaunchRequest: true,
      hasRuntimeStart: false,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([])
  })

  it('suppresses running recovery when the runtime projection is unavailable', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'corrupt-runtime-job',
      status: makeStatus('corrupt-runtime-job', 'running'),
      launch: makeLaunch('corrupt-runtime-job'),
      runtime: null,
      hasLaunchRequest: true,
      hasRuntimeStart: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([])
  })

  it('returns no action for projection fact combinations without recovery semantics', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'unknown-job',
      status: makeStatus('unknown-job', 'queued'),
      launch: makeLaunch('unknown-job'),
      runtime: makeRuntime('unknown-job'),
      hasLaunchRequest: true,
      hasRuntimeStart: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([])
  })

  it('produces identical output for identical input snapshots', () => {
    const snapshot = new InMemoryRecoverySnapshot()
      .addJob({
        jobId: 'running-a',
        status: makeStatus('running-a', 'running'),
        launch: makeLaunch('running-a', { enqueueSequence: 30 }),
        runtime: makeRuntime('running-a', { pid: 3001 }),
        hasLaunchRequest: true,
        hasRuntimeStart: true,
      })
      .addJob({
        jobId: 'queued-b',
        status: makeStatus('queued-b', 'queued'),
        launch: makeLaunch('queued-b', { enqueueSequence: 2 }),
        hasLaunchRequest: true,
        hasRuntimeStart: false,
      })
      .addJob({
        jobId: 'ghost-c',
        status: makeStatus('ghost-c', 'launching'),
        launch: makeLaunch('ghost-c', { enqueueSequence: 9 }),
        hasLaunchRequest: true,
        hasRuntimeStart: false,
      })
      .addSession({
        scopeKey: '/sessions/deterministic',
        sessionId: 'deterministic-claim',
        provider: 'fakeprovider',
        activeJobId: 'missing-d',
      })

    const first = planRecovery(snapshot)
    const second = planRecovery(snapshot)

    expect(first.register).toEqual(second.register)
    expect(first.cleanup).toEqual(second.cleanup)
  })

  it('orders actions by registration bridge contract', () => {
    const runningSecondLaunch = makeLaunch('running-second', { enqueueSequence: 30 })
    const runningSecondRuntime = makeRuntime('running-second', { pid: 4001 })
    const queuedLateLaunch = makeLaunch('queued-late', { enqueueSequence: 9 })
    const queuedEarlyLaunch = makeLaunch('queued-early', { enqueueSequence: 1 })
    const runningFirstLaunch = makeLaunch('running-first', { enqueueSequence: 40 })
    const runningFirstRuntime = makeRuntime('running-first', { pid: 4002 })
    const staleDeadLaunch = makeLaunch('stale-dead', { enqueueSequence: 50 })
    const staleDeadRuntime = makeRuntime('stale-dead', { pid: 4003 })

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
    )

    expect(summarizeActions(plan.register)).toEqual([
      { type: 'registerRunning', jobId: 'running-second', transport: 'durable-cli' },
      { type: 'registerRunning', jobId: 'running-first', transport: 'durable-cli' },
      { type: 'registerRunning', jobId: 'stale-dead', transport: 'durable-cli' },
      { type: 'registerQueued', jobId: 'queued-early', enqueueSequence: 1 },
      { type: 'registerQueued', jobId: 'queued-late', enqueueSequence: 9 },
    ])
    expect(summarizeActions(plan.cleanup)).toEqual([
      { type: 'discardIncompleteAdmission', jobId: 'incomplete' },
      { type: 'markError', jobId: 'missing-launch', fault: 'missing_launch_record' },
      { type: 'markError', jobId: 'ghost', fault: 'ghost_launch' },
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
    ])
  })

  it('propagates snapshot read failures', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'throwing-job',
      status: makeStatus('throwing-job', 'running'),
      launch: makeLaunch('throwing-job'),
      runtime: makeRuntime('throwing-job'),
      hasLaunchRequest: true,
      hasRuntimeStart: true,
    })

    ;(snapshot as any).readJob = () => {
      throw new Error('broken readJob')
    }
    ;(snapshot as any).listSessionRefs = () => {
      throw new Error('broken listSessionRefs')
    }

    expect(() => planRecovery(snapshot)).toThrow('broken readJob')
  })

})
