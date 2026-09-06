import { describe, it, expect, vi } from 'vitest';
import { RecoveryRegistry } from '#src/jobs/reconcile/registry.js';
import type { AppServerRuntime, ProviderJobLaunch } from '#src/jobs/records.js';
import type { DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';

function makeLaunchRecord(overrides: Partial<ProviderJobLaunch> = {}): ProviderJobLaunch {
  return {
    jobId: 'job-1',
    owner: { kind: 'provider-session', id: 'sess-1' },
    sessionId: 'sess-1',
    provider: 'codex',
    projectRoot: '/tmp/test',
    backendNamespace: 'ns1',
    jobKind: 'provider',
    pool: 'default',
    enqueueSequence: 1,
    providerAction: 'exec',
    request: { prompt: 'hello', cwd: '/tmp/test', bypassPermissions: false, coralEnv: {} },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRuntimeRecord(overrides: Partial<DurableCliRuntimeRecord> = {}): DurableCliRuntimeRecord {
  return {
    transport: 'durable-cli',
    pid: 12345,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    startTime: new Date().toISOString(),
    ...overrides,
  };
}

type AcquiredAppServerRuntime = Extract<AppServerRuntime, { providerMeta: { leaseState: 'acquired' } }>;

function makeAppServerRuntimeRecord(
  overrides: Partial<AcquiredAppServerRuntime['providerMeta']> = {},
): AppServerRuntime {
  return {
    transport: 'app-server',
    startTime: new Date().toISOString(),
    providerMeta: {
      provider: 'codex',
      leaseState: 'acquired',
      hostRef: {
        provider: 'test',
        fingerprint: '0'.repeat(64),
        instanceId: 'instance-1',
        leaseMode: 'shared',
      },
      ...overrides,
    },
  };
}

describe('RecoveryRegistry', () => {
  it('registers and finds entries', () => {
    const reg = new RecoveryRegistry();
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }));
    expect(reg.has('j1')).toBe(true);
    expect(reg.has('j2')).toBe(false);
    expect(reg.size).toBe(1);
  });

  it('retrieves registered entry by jobId', () => {
    const reg = new RecoveryRegistry();
    const launch = makeLaunchRecord({ jobId: 'j1' });
    reg.register('j1', launch);
    const entry = reg.get('j1');
    expect(entry).toBeDefined();
    expect(entry!.launchRecord).toBe(launch);
    expect(entry!.runtimeRecord).toBeUndefined();
  });

  it('retrieves entry with runtimeRecord when provided', () => {
    const reg = new RecoveryRegistry();
    const launch = makeLaunchRecord({ jobId: 'j1' });
    const runtime = makeRuntimeRecord();
    reg.register('j1', launch, runtime);
    const entry = reg.get('j1');
    expect(entry!.runtimeRecord).toBe(runtime);
  });

  it('returns undefined for unknown jobId', () => {
    const reg = new RecoveryRegistry();
    expect(reg.get('nonexistent')).toBeUndefined();
  });

  it('removes entries', () => {
    const reg = new RecoveryRegistry();
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }));
    reg.remove('j1');
    expect(reg.has('j1')).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('remove is a no-op for unknown jobId', () => {
    const reg = new RecoveryRegistry();
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }));
    reg.remove('j2');
    expect(reg.size).toBe(1);
  });

  it('abort returns notFound for unknown jobs', () => {
    const reg = new RecoveryRegistry();
    const result = reg.abort(['unknown']);
    expect(result.notFound).toEqual(['unknown']);
    expect(result.aborted).toEqual([]);
  });

  it('abort succeeds for a running job only after its containment handler accepts', () => {
    const abortHandler = vi.fn(() => ({ kind: 'accepted' as const }));
    const reg = new RecoveryRegistry();
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }), makeRuntimeRecord(), abortHandler);
    const result = reg.abort(['j1']);
    expect(result.aborted).toEqual(['j1']);
    expect(result.notFound).toEqual([]);
    expect(abortHandler).toHaveBeenCalledOnce();
    expect(reg.has('j1')).toBe(false);
  });

  it('releases explicitly abandoned recovery ownership without reporting the job aborted', () => {
    const cancelledJobIds = new Set<string>();
    const reg = new RecoveryRegistry(cancelledJobIds);
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }), makeRuntimeRecord(), () => ({
      kind: 'abandoned',
      reason: 'recovery ownership was released without proof of process absence',
      nextStep: 'Inspect the process outside Coral.',
    }));

    expect(reg.abort(['j1'])).toEqual({
      aborted: [],
      notFound: [],
      abandoned: [
        {
          jobId: 'j1',
          reason: 'recovery ownership was released without proof of process absence',
          nextStep: 'Inspect the process outside Coral.',
        },
      ],
    });
    expect(reg.has('j1')).toBe(false);
    expect(cancelledJobIds.has('j1')).toBe(false);
  });

  it('retains running-job ownership when its containment abort is refused', () => {
    const cancelledJobIds = new Set<string>();
    const reg = new RecoveryRegistry(cancelledJobIds);
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }), makeRuntimeRecord(), () => ({
      kind: 'refused',
      reason: 'leader pid recycled',
    }));

    expect(reg.abort(['j1'])).toEqual({
      aborted: [],
      notFound: [],
      refused: [
        {
          jobId: 'j1',
          reason: 'leader pid recycled',
          nextStep:
            'Run coral-cli jobs detail j1; restore signal authorization or wait until the recorded containment ' +
            'is observed absent, then retry the abort.',
        },
      ],
    });
    expect(reg.has('j1')).toBe(true);
    expect(cancelledJobIds.has('j1')).toBe(false);
  });

  it('abort cancels queued jobs without reporting a no-op success', () => {
    const cancelledJobIds = new Set<string>();
    const reg = new RecoveryRegistry(cancelledJobIds);
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }));
    const result = reg.abort(['j1']);
    expect(result.aborted).toEqual(['j1']);
    expect(result.notFound).toEqual([]);
    expect(cancelledJobIds.has('j1')).toBe(true);
    expect(reg.has('j1')).toBe(false);
  });

  it('abort handles mixed found and notFound jobs', () => {
    const reg = new RecoveryRegistry();
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }));
    reg.register('j2', makeLaunchRecord({ jobId: 'j2' }), makeRuntimeRecord(), () => ({ kind: 'accepted' }));
    const result = reg.abort(['j1', 'missing', 'j2']);
    expect(result.aborted).toEqual(['j1', 'j2']);
    expect(result.notFound).toEqual(['missing']);
  });

  it('retains an app-server entry after acknowledgment until terminal finalization releases it', async () => {
    const reg = new RecoveryRegistry();
    const abortDelegate = vi.fn();
    const acknowledged = {
      kind: 'finalization-pending' as const,
      reason: 'provider interruption was acknowledged; terminal finalization remains pending',
      nextStep: 'Wait for terminal finalization.',
    };
    let acknowledge!: (value: typeof acknowledged) => void;
    const settlement = new Promise<typeof acknowledged>((resolve) => {
      acknowledge = resolve;
    });

    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }), makeAppServerRuntimeRecord(), () => {
      abortDelegate();
      return {
        kind: 'held',
        reason: 'provider interruption acknowledgment is pending',
        nextStep: 'Wait for the provider acknowledgment, then inspect the job.',
        settlement,
      };
    });

    expect(reg.abort(['j1'])).toEqual({
      aborted: [],
      notFound: [],
      held: [
        {
          jobId: 'j1',
          reason: 'provider interruption acknowledgment is pending',
          nextStep: 'Wait for the provider acknowledgment, then inspect the job.',
        },
      ],
    });
    expect(abortDelegate).toHaveBeenCalledTimes(1);
    expect(reg.has('j1')).toBe(true);

    acknowledge(acknowledged);
    await settlement;
    await Promise.resolve();

    expect(reg.has('j1')).toBe(true);
    expect(reg.abort(['j1'])).toEqual({
      aborted: [],
      notFound: [],
      held: [{ jobId: 'j1', reason: acknowledged.reason, nextStep: acknowledged.nextStep }],
    });
  });

  it('retains ownership when an asynchronous abort owner settles with refusal', async () => {
    const reg = new RecoveryRegistry();
    const settlement = Promise.resolve({
      kind: 'refused' as const,
      reason: 'the provider did not acknowledge interruption',
      nextStep: 'Repair provider continuity, then retry recovery.',
    });
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }), makeAppServerRuntimeRecord(), () => ({
      kind: 'held',
      reason: 'provider interruption acknowledgment is pending',
      nextStep: 'Wait for the provider acknowledgment, then inspect the job.',
      settlement,
    }));

    reg.abort(['j1']);
    await settlement;
    await Promise.resolve();

    expect(reg.abort(['j1'])).toEqual({
      aborted: [],
      notFound: [],
      refused: [
        {
          jobId: 'j1',
          reason: 'the provider did not acknowledge interruption',
          nextStep: 'Repair provider continuity, then retry recovery.',
        },
      ],
    });
    expect(reg.has('j1')).toBe(true);
  });

  it('groups entries by projectRoot', () => {
    const reg = new RecoveryRegistry();
    reg.register('j1', makeLaunchRecord({ jobId: 'j1', projectRoot: '/a' }));
    reg.register('j2', makeLaunchRecord({ jobId: 'j2', projectRoot: '/b' }));
    reg.register('j3', makeLaunchRecord({ jobId: 'j3', projectRoot: '/a' }));
    const byProject = reg.entriesByProject();
    expect(byProject.get('/a')?.length).toBe(2);
    expect(byProject.get('/b')?.length).toBe(1);
  });

  it('entriesByProject returns empty map when registry is empty', () => {
    const reg = new RecoveryRegistry();
    const byProject = reg.entriesByProject();
    expect(byProject.size).toBe(0);
  });

  it('iterates entries via Symbol.iterator', () => {
    const reg = new RecoveryRegistry();
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }));
    reg.register('j2', makeLaunchRecord({ jobId: 'j2' }));
    const entries = [...reg];
    expect(entries.length).toBe(2);
    expect(entries.map(([id]) => id).sort()).toEqual(['j1', 'j2']);
  });

  it('iterates zero entries when empty', () => {
    const reg = new RecoveryRegistry();
    const entries = [...reg];
    expect(entries.length).toBe(0);
  });
});
