import { describe, expect, it, vi } from 'vitest';
import { createBuiltInProviderRegistry } from '#src/providers/bootstrap.js';
import { consumeJobStream } from '#src/jobs/shell/continuity-consumer.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { TEST_CODEX_BINDING } from '#tests/helpers/provider-credentials.js';
import { ProcessContainmentError } from '#src/infra/process-containment.js';
import { providerHostInventorySchema } from '#src/providers/host-inventory-schema.js';
import { backendLog } from '#src/infra/backend-log.js';
import {
  StubbedContainmentProviderHostManager,
  createFakeProviderServerHandle,
  createSpawnProviderServerMock,
  noCarrierBlocksRetirement,
  runtime,
} from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

async function harness(options: { failContainment?: boolean } = {}) {
  vi.useFakeTimers();
  const containment = createDeferred();
  const started = createDeferred();
  const reap = vi.fn(async () => {
    await containment.promise;
    if (options.failContainment)
      throw new ProcessContainmentError('process_identity_unverified', 'identity unobservable');
  });
  const server = createFakeProviderServerHandle({
    generation: 811,
    request: async (method) => {
      if (method === 'config/read') return { config: {} };
      if (method === 'model/list')
        return {
          data: [{ model: 'gpt-6-sol', hidden: false, upgrade: null, supportedReasoningEfforts: [] }],
          nextCursor: null,
        };
      if (method === 'thread/start') return { thread: { id: 'thread-local' } };
      if (method === 'turn/start') {
        started.resolve();
        return { turn: { id: 'turn-local', status: 'inProgress' } };
      }
      if (method === 'thread/read')
        return { thread: { id: 'thread-local', turns: [{ id: 'turn-local', status: 'inProgress' }] } };
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      return {};
    },
  });
  const manager = new StubbedContainmentProviderHostManager({
    runtime,
    carrierBlocksRetirement: noCarrierBlocksRetirement,
    spawnProviderServer: createSpawnProviderServerMock(server.handle),
    reapContainment: reap,
  });
  const accept =
    manager.acceptTurnContainment === undefined
      ? vi.fn<typeof manager.acceptTurnContainment>()
      : vi.spyOn(manager, 'acceptTurnContainment');
  const registry = createBuiltInProviderRegistry();
  registry.connectAppServerHost(manager);
  const binding = registry.rehydrateBinding(TEST_CODEX_BINDING);
  if (!binding.ok) throw new Error('fixture binding failed');
  const provider = binding.value;
  const cwd = fixtureCanonicalWorkDir(process.cwd());
  const prepared = provider.prepareExecution({
    request: { action: 'exec', jobId: 'job-local', prompt: 'answer', cwd, bypassPermissions: false, coralEnv: {} },
    baseEnv: {},
    platform: 'linux',
    storage: runtime.storage,
    hostRoot: '/fixture',
  });
  if (prepared.kind !== 'app-server') throw new Error('expected app-server execution');
  const sibling = await manager.openSession(prepared.hostSpec, { jobId: 'job-sibling' });
  const job = consumeJobStream({
    jobId: 'job-local',
    execution: 1,
    stream: prepared.execute({
      transport: 'app-server',
      jobId: 'job-local',
      signal: new AbortController().signal,
      time: runtime.time,
      storage: runtime.storage,
      ids: runtime.ids,
      kbRoot: '/fixture/kb',
      continuityBridge: { checkpoint: () => {}, transportClosed: () => {} },
      onAppServerWaiting: () => {},
      onHostRef: () => {},
      onProviderTurnTerminal: () => {},
    }),
    decodeContinuity: provider.decodeContinuity,
    conversationApi: {
      checkpointJobContinuityAtomic: vi.fn().mockResolvedValue({ ok: true, execution: 1 }),
      recordArtifactHandleAtomic: vi.fn(),
    },
    appendProgress: () => {},
  });
  await started.promise;
  await vi.advanceTimersByTimeAsync(0);
  const emit = (method: string, extra: Record<string, unknown>) =>
    server.emitNotification({ method, params: { threadId: 'thread-local', turnId: 'turn-local', ...extra } });
  emit('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'answer', phase: 'final_answer' } });
  await vi.advanceTimersByTimeAsync(250);
  let recorded = false;
  void job.then(() => {
    recorded = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  const unsubscribes = () => server.requestMock.mock.calls.filter(([method]) => method === 'thread/unsubscribe').length;
  const finish = () => emit('turn/completed', { turn: { id: 'turn-local', status: 'completed' } });
  return {
    manager,
    server,
    accept,
    containment,
    reap,
    sibling,
    job,
    unsubscribes,
    finish,
    recorded: () => recorded,
  };
}

describe('coordinator-local Codex settlement', () => {
  it('records the outcome while retaining the lease until exact terminal evidence releases it for idle retirement', async () => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const h = await harness();
    expect(h.unsubscribes()).toBe(0);
    expect(h.recorded()).toBe(true);
    await expect(h.job).resolves.toMatchObject({
      kind: 'terminal',
      event: { terminal: { content: 'answer', outcome: { kind: 'completed' } } },
    });
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.server.handle.isClosed()).toBe(false);
    h.sibling.close();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.reap).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    h.finish();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(h.unsubscribes()).toBe(1);
    expect(h.reap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(h.reap).toHaveBeenCalledOnce();
    h.containment.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.server.handle.isClosed()).toBe(true);
  });

  it('transfers the exact turn and lease, fences the shared host, and closes only after containment including its sibling', async () => {
    const warn = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});
    const h = await harness();
    await vi.advanceTimersByTimeAsync(63_000);
    expect(h.accept).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('origin.jobId=job-sibling'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('origin.jobId=job-local'));
    const obligation = h.accept.mock.calls[0][0];
    expect(obligation.settlement.providerTurnId).toBe('turn-local');
    expect(obligation.lease.hostRef).toEqual(h.sibling.hostRef);
    const close = vi.spyOn(obligation.settlement, 'close');
    expect(h.reap).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(h.unsubscribes()).toBe(0);
    expect(h.manager.listProviderHosts().filter(({ status }) => status === 'live')).toEqual([]);
    expect(h.server.handle.isClosed()).toBe(false);
    h.containment.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.server.handle.isClosed()).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    await expect(h.sibling.session.closed).resolves.toBeUndefined();
    h.sibling.close();
  });

  it('keeps the exact obligation visible in reclamation-failed when containment fails', async () => {
    vi.spyOn(backendLog, 'error').mockImplementation(() => {});
    const h = await harness({ failContainment: true });
    await vi.advanceTimersByTimeAsync(63_000);
    expect(h.accept).toHaveBeenCalledOnce();
    const close = vi.spyOn(h.accept.mock.calls[0][0].settlement, 'close');
    h.containment.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const inventory = h.manager.listProviderHosts();
    expect(inventory).toMatchObject([
      {
        status: 'reclamation-failed',
        ref: h.sibling.hostRef,
        host: {
          reclamationAttempts: 1,
          reclamationRetryable: false,
          reclamationFailure: expect.stringContaining('turn-local'),
        },
      },
    ]);
    expect(() => providerHostInventorySchema.parse(inventory)).not.toThrow();
    expect(close).not.toHaveBeenCalled();
    expect(h.unsubscribes()).toBe(0);
    expect(h.server.handle.isClosed()).toBe(false);
    h.sibling.close();
  });
});
