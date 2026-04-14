import { describe, expect, it } from 'vitest'
import type {
  PersistedExitRecord,
  PersistedLaunchRecord,
  PersistedRuntimeRecord,
  PersistedStatusRecord,
  SessionEntry,
  TerminalResult,
} from '../../shared/types.js'
import { GHOST_LAUNCH_NOTICE, OLD_FORMAT_NOTICE } from '../recovery-notices.js'
import type { JobStoreSnapshot, RecoveryAction, RecoveryPlan } from '../recovery-core.js'
import { planRecovery } from '../recovery-core.js'

const NOW = '2026-04-12T00:00:00.000Z'
const CURRENT_NAMESPACE = 'namespace-current'
const FOREIGN_NAMESPACE = 'namespace-foreign'

type JobFixture = {
  jobId: string
  status?: PersistedStatusRecord | null
  launch?: PersistedLaunchRecord | null
  runtime?: PersistedRuntimeRecord | null
  exit?: PersistedExitRecord | null
  terminalPayload?: TerminalResult | null
  hasLaunch?: boolean
  hasRuntime?: boolean
  hasExit?: boolean
  includeInJobIds?: boolean
}

type SessionFixture = {
  shardDir: string
  sessionId: string
  provider: string
  activeJobId?: string
  entry?: SessionEntry | null
}

type StoredJob = {
  hasLaunch: boolean
  hasRuntime: boolean
  hasExit: boolean
  status: PersistedStatusRecord | null
  launch: PersistedLaunchRecord | null
  runtime: PersistedRuntimeRecord | null
  exit: PersistedExitRecord | null
  terminalPayload: TerminalResult | null
}

class InMemoryRecoverySnapshot implements JobStoreSnapshot {
  readonly jobIds: string[] = []
  readonly currentNamespace: string
  private readonly jobs = new Map<string, StoredJob>()
  private readonly sessionRefs: Array<{ shardDir: string; sessionId: string; provider: string }> = []
  private readonly sessions = new Map<string, SessionEntry | null>()

  constructor(currentNamespace = CURRENT_NAMESPACE) {
    this.currentNamespace = currentNamespace
  }

  addJob(fixture: JobFixture): this {
    this.jobs.set(fixture.jobId, {
      hasLaunch: fixture.hasLaunch ?? (fixture.launch !== undefined && fixture.launch !== null),
      hasRuntime: fixture.hasRuntime ?? (fixture.runtime !== undefined && fixture.runtime !== null),
      hasExit: fixture.hasExit ?? (fixture.exit !== undefined && fixture.exit !== null),
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
      shardDir: fixture.shardDir,
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

    this.sessions.set(this.sessionKey(fixture.shardDir, fixture.provider, fixture.sessionId), entry)
    return this
  }

  hasLaunch(jobId: string): boolean {
    return this.jobs.get(jobId)?.hasLaunch ?? false
  }

  hasRuntime(jobId: string): boolean {
    return this.jobs.get(jobId)?.hasRuntime ?? false
  }

  hasExit(jobId: string): boolean {
    return this.jobs.get(jobId)?.hasExit ?? false
  }

  readStatus(jobId: string): PersistedStatusRecord | null {
    return this.jobs.get(jobId)?.status ?? null
  }

  readLaunch(jobId: string): PersistedLaunchRecord | null {
    return this.jobs.get(jobId)?.launch ?? null
  }

  readRuntime(jobId: string): PersistedRuntimeRecord | null {
    return this.jobs.get(jobId)?.runtime ?? null
  }

  readExit(jobId: string): PersistedExitRecord | null {
    return this.jobs.get(jobId)?.exit ?? null
  }

  readTerminalPayload(jobId: string): TerminalResult | null {
    return this.jobs.get(jobId)?.terminalPayload ?? null
  }

  listSessionRefs(): Array<{ shardDir: string; sessionId: string; provider: string }> {
    return this.sessionRefs.map((ref) => ({ ...ref }))
  }

  readSession(shardDir: string, provider: string, sessionId: string): SessionEntry | null {
    return this.sessions.get(this.sessionKey(shardDir, provider, sessionId)) ?? null
  }

  private sessionKey(shardDir: string, provider: string, sessionId: string): string {
    return `${shardDir}::${provider}::${sessionId}`
  }
}

function makeStatus(
  jobId: string,
  phase: PersistedStatusRecord['phase'],
  overrides: Partial<PersistedStatusRecord> & {
    launch?: Partial<PersistedStatusRecord['launch']>
  } = {},
): PersistedStatusRecord {
  const base: PersistedStatusRecord = {
    jobId,
    sessionId: `${jobId}-session`,
    provider: 'fakeprovider',
    projectRoot: `/projects/${jobId}`,
    backendNamespace: CURRENT_NAMESPACE,
    phase,
    launch: {
      state: 'pending',
      updatedAt: NOW,
    },
  }

  return {
    ...base,
    ...overrides,
    launch: {
      ...base.launch,
      ...overrides.launch,
    },
  }
}

function makeLaunch(
  jobId: string,
  overrides: Partial<PersistedLaunchRecord> & {
    request?: Partial<PersistedLaunchRecord['request']>
  } = {},
): PersistedLaunchRecord {
  const base: PersistedLaunchRecord = {
    jobId,
    sessionId: `${jobId}-session`,
    provider: 'fakeprovider',
    projectRoot: `/projects/${jobId}`,
    backendNamespace: CURRENT_NAMESPACE,
    pool: 'default',
    enqueueSequence: 0,
    providerAction: 'exec',
    request: {
      prompt: `prompt-${jobId}`,
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

function makeRuntime(jobId: string, overrides: Partial<PersistedRuntimeRecord> = {}): PersistedRuntimeRecord {
  return {
    pid: 1000,
    stdoutPath: `/tmp/${jobId}.stdout`,
    stderrPath: `/tmp/${jobId}.stderr`,
    startTime: NOW,
    ...overrides,
  } as PersistedRuntimeRecord
}

function makeAppServerRuntime(overrides: Partial<PersistedRuntimeRecord> = {}): PersistedRuntimeRecord {
  return {
    transport: 'app-server',
    startTime: NOW,
    providerMeta: {
      provider: 'fakeprovider',
      leaseState: 'acquired',
      recoveryPolicy: 'session_continuity_only',
    },
    ...overrides,
  } as PersistedRuntimeRecord
}

function makeExit(overrides: Partial<PersistedExitRecord> = {}): PersistedExitRecord {
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
    sessionId,
    provider,
    name: `${sessionId}-name`,
    state: 'ready',
    cwd: '/workspace',
    createdAt: NOW,
    lastUsedAt: NOW,
    version: 1,
    ...overrides,
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
          notice: action.notice,
        }
      case 'releaseSessionClaim':
        return {
          type: action.type,
          shardDir: action.shardDir,
          sessionId: action.sessionId,
          jobId: action.jobId,
        }
      default:
        return action
    }
  })
}

describe('planRecovery', () => {
  it('returns deleteIncompleteDir for incomplete admission', () => {
    const snapshot = new InMemoryRecoverySnapshot()
      .addJob({
        jobId: 'incomplete-job',
        status: null,
        launch: makeLaunch('incomplete-job'),
        hasLaunch: true,
      })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      { type: 'deleteIncompleteDir', jobId: 'incomplete-job' },
    ])
  })

  it('returns markError with OLD_FORMAT_NOTICE for incompatible live jobs', () => {
    const status = makeStatus('incompatible-job', 'launching')
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'incompatible-job',
      status,
      hasLaunch: false,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'markError',
        jobId: 'incompatible-job',
        notice: OLD_FORMAT_NOTICE,
        status,
      },
    ])
  })

  it('returns markError with GHOST_LAUNCH_NOTICE for stale_running jobs', () => {
    const status = makeStatus('ghost-job', 'running')
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'ghost-job',
      status,
      launch: makeLaunch('ghost-job'),
      hasLaunch: true,
      hasRuntime: false,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'markError',
        jobId: 'ghost-job',
        notice: GHOST_LAUNCH_NOTICE,
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
      hasLaunch: true,
      hasRuntime: false,
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
      hasLaunch: true,
      hasRuntime: true,
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
      hasLaunch: true,
      hasRuntime: true,
      hasExit: true,
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
      hasLaunch: true,
      hasRuntime: true,
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
      hasLaunch: true,
      hasRuntime: true,
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
        hasLaunch: true,
        hasRuntime: true,
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
        shardDir: '/sessions/a',
        sessionId: 'terminal-claim',
        provider: 'fakeprovider',
        activeJobId: 'terminal-claimed-job',
      })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'releaseSessionClaim',
        shardDir: '/sessions/a',
        sessionId: 'terminal-claim',
        jobId: 'terminal-claimed-job',
      },
    ])
  })

  it('returns releaseSessionClaim for orphaned active job claims', () => {
    const snapshot = new InMemoryRecoverySnapshot().addSession({
      shardDir: '/sessions/a',
      sessionId: 'orphan-claim',
      provider: 'fakeprovider',
      activeJobId: 'missing-job',
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'releaseSessionClaim',
        shardDir: '/sessions/a',
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
        shardDir: '/sessions/foreign',
        sessionId: 'foreign-terminal-claim',
        provider: 'fakeprovider',
        activeJobId: 'foreign-terminal-job',
      })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      {
        type: 'releaseSessionClaim',
        shardDir: '/sessions/foreign',
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
        hasLaunch: true,
        hasRuntime: true,
      })
      .addSession({
        shardDir: '/sessions/live',
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

  it('treats corrupt status reads as incomplete admission when launch exists', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'corrupt-status-job',
      status: null,
      launch: makeLaunch('corrupt-status-job'),
      hasLaunch: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([
      { type: 'deleteIncompleteDir', jobId: 'corrupt-status-job' },
    ])
  })

  it('suppresses queued recovery when launch.json parses as null', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'corrupt-launch-job',
      status: makeStatus('corrupt-launch-job', 'queued'),
      launch: null,
      hasLaunch: true,
      hasRuntime: false,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([])
  })

  it('suppresses running recovery when runtime.json parses as null', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'corrupt-runtime-job',
      status: makeStatus('corrupt-runtime-job', 'running'),
      launch: makeLaunch('corrupt-runtime-job'),
      runtime: null,
      hasLaunch: true,
      hasRuntime: true,
    })

    const plan = planRecovery(snapshot)
    expect(plan.register).toEqual([])
    expect(plan.cleanup).toEqual([])
  })

  it('returns no action for unrecognized classifier rows', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'unknown-job',
      status: makeStatus('unknown-job', 'queued'),
      launch: makeLaunch('unknown-job'),
      runtime: makeRuntime('unknown-job'),
      hasLaunch: true,
      hasRuntime: true,
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
        hasLaunch: true,
        hasRuntime: true,
      })
      .addJob({
        jobId: 'queued-b',
        status: makeStatus('queued-b', 'queued'),
        launch: makeLaunch('queued-b', { enqueueSequence: 2 }),
        hasLaunch: true,
        hasRuntime: false,
      })
      .addJob({
        jobId: 'ghost-c',
        status: makeStatus('ghost-c', 'launching'),
        launch: makeLaunch('ghost-c', { enqueueSequence: 9 }),
        hasLaunch: true,
        hasRuntime: false,
      })
      .addSession({
        shardDir: '/sessions/deterministic',
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
          hasLaunch: true,
          hasRuntime: true,
        })
        .addJob({
          jobId: 'incomplete',
          status: null,
          launch: makeLaunch('incomplete'),
          hasLaunch: true,
        })
        .addJob({
          jobId: 'incompatible',
          status: makeStatus('incompatible', 'launching'),
          hasLaunch: false,
        })
        .addJob({
          jobId: 'queued-late',
          status: makeStatus('queued-late', 'queued'),
          launch: queuedLateLaunch,
          hasLaunch: true,
          hasRuntime: false,
        })
        .addJob({
          jobId: 'ghost',
          status: makeStatus('ghost', 'running'),
          launch: makeLaunch('ghost'),
          hasLaunch: true,
          hasRuntime: false,
        })
        .addJob({
          jobId: 'queued-early',
          status: makeStatus('queued-early', 'queued'),
          launch: queuedEarlyLaunch,
          hasLaunch: true,
          hasRuntime: false,
        })
        .addJob({
          jobId: 'running-first',
          status: makeStatus('running-first', 'launching'),
          launch: runningFirstLaunch,
          runtime: runningFirstRuntime,
          hasLaunch: true,
          hasRuntime: true,
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
          hasLaunch: true,
          hasRuntime: true,
          hasExit: true,
        })
        .addSession({
          shardDir: '/sessions/order',
          sessionId: 'terminal-claim',
          provider: 'fakeprovider',
          activeJobId: 'terminal',
        })
        .addSession({
          shardDir: '/sessions/order',
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
      { type: 'deleteIncompleteDir', jobId: 'incomplete' },
      { type: 'markError', jobId: 'incompatible', notice: OLD_FORMAT_NOTICE },
      { type: 'markError', jobId: 'ghost', notice: GHOST_LAUNCH_NOTICE },
      {
        type: 'releaseSessionClaim',
        shardDir: '/sessions/order',
        sessionId: 'terminal-claim',
        jobId: 'terminal',
      },
      {
        type: 'releaseSessionClaim',
        shardDir: '/sessions/order',
        sessionId: 'orphan-claim',
        jobId: 'missing-job',
      },
    ])
  })

  it('malformed snapshots never throw', () => {
    const snapshot = new InMemoryRecoverySnapshot().addJob({
      jobId: 'throwing-job',
      status: makeStatus('throwing-job', 'running'),
      launch: makeLaunch('throwing-job'),
      runtime: makeRuntime('throwing-job'),
      hasLaunch: true,
      hasRuntime: true,
    })

    ;(snapshot as any).hasLaunch = () => {
      throw new Error('broken hasLaunch')
    }
    ;(snapshot as any).readStatus = () => {
      throw new Error('broken readStatus')
    }
    ;(snapshot as any).listSessionRefs = () => {
      throw new Error('broken listSessionRefs')
    }

    let thrown: unknown = null
    let result: RecoveryPlan = { register: [], cleanup: [] }

    try {
      result = planRecovery(snapshot)
    } catch (error: unknown) {
      thrown = error
    }

    expect(thrown).toBeNull()
    expect(result.register).toEqual([])
    expect(result.cleanup).toEqual([])
  })

})
