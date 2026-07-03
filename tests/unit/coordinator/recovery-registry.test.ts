import { describe, it, expect, vi } from 'vitest';
import { RecoveryRegistry } from '#src/jobs/reconcile/registry.js';
import type { AppServerRuntime, JobLaunch } from '#src/jobs/records.js';
import type { DurableCliRuntimeRecord } from '#src/runtime/durable-runtime.js';

function makeLaunchRecord(overrides: Partial<JobLaunch> = {}): JobLaunch {
  return {
    jobId: 'job-1',
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
    pid: 12345,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    startTime: new Date().toISOString(),
    ...overrides,
  };
}

function makeAppServerRuntimeRecord(overrides: Partial<AppServerRuntime['providerMeta']> = {}): AppServerRuntime {
  return {
    transport: 'app-server',
    startTime: new Date().toISOString(),
    providerMeta: {
      provider: 'codex',
      leaseState: 'acquired',
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

  it('abort succeeds for registered jobs with runtimeRecord', () => {
    const kill = vi.fn();
    const reg = new RecoveryRegistry({ kill });
    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }), makeRuntimeRecord());
    const result = reg.abort(['j1']);
    expect(result.aborted).toEqual(['j1']);
    expect(result.notFound).toEqual([]);
    expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM');
  });

  it('abort cancels queued jobs without reporting a no-op success', () => {
    const cancelledJobIds = new Set<string>();
    const reg = new RecoveryRegistry(undefined, cancelledJobIds);
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
    reg.register('j2', makeLaunchRecord({ jobId: 'j2' }), makeRuntimeRecord());
    const result = reg.abort(['j1', 'missing', 'j2']);
    expect(result.aborted).toEqual(['j1', 'j2']);
    expect(result.notFound).toEqual(['missing']);
  });

  it('uses the registered app-server abort delegate instead of a PID handler', () => {
    const reg = new RecoveryRegistry();
    const abortDelegate = vi.fn();

    reg.register('j1', makeLaunchRecord({ jobId: 'j1' }), makeAppServerRuntimeRecord(), abortDelegate);

    expect(reg.abort(['j1'])).toEqual({
      aborted: ['j1'],
      notFound: [],
    });
    expect(abortDelegate).toHaveBeenCalledTimes(1);
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
