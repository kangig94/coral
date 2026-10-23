import { describe, expect, it, vi } from 'vitest';
import { JobAttention } from '#src/coordinator/services/job-attention.js';
import { JobWaitService } from '#src/coordinator/services/job-wait.js';
import type { WaitStreamRequest } from '#src/jobs/wait/contract.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import { jobsWaitRequest } from '#src/transport/rpc/jobs.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';
import { waitExecutions } from '#tests/helpers/wait-executions.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

const projectRoot = canonicalizeWorkDir(process.cwd(), process.cwd());
const spec = rpcCatalog.find((entry) => entry.name === 'jobs.wait')!;

async function fixture() {
  const f = waitExecutions();
  f.request('job', 10);
  const attention = new JobAttention();
  const service = new JobWaitService({
    jobAttention: attention,
    runtime: { time: f.time },
    waitCoordinator: f.coordinator,
    loadJobProjectionDetail: (id) => ({ ...f.load(id), launch: null }),
    subscribeJobEvents: () => ({ async *[Symbol.asyncIterator]() {} }),
    getCurrentJournalSeq: () => f.histories.get('job')!.at(-1)!.status!.lastSeq!,
  });
  let streamedRequest: WaitStreamRequest | undefined;
  const ports = {
    identity: { pluginRoot: '/plugin', bootToken: 'test', now: () => 0, log: vi.fn() },
    coralEnvSnapshot: {},
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
    },
    jobs: {
      admitWait: (request: WaitStreamRequest) => f.coordinator.admitWait(request),
      waitStream: (request: WaitStreamRequest) => {
        streamedRequest = request;
        return service.waitStream(request);
      },
      waitHandoverSignal: () => undefined,
    },
  } as unknown as HttpHandlerPorts;
  const controller = new AbortController();
  const result = await executeCatalogRequest(
    spec,
    jobsWaitRequest({ jobIds: ['job'], projectRoot }),
    ports,
    testProjectPrincipal(projectRoot),
    controller.signal,
  );
  if (result.kind !== 'subscription') throw new Error('Expected wait subscription');
  return {
    ...f,
    attention,
    controller,
    waitRequest: streamedRequest!,
    stream: result.notifications[Symbol.asyncIterator](),
  };
}

describe('attention after transport wait admission', () => {
  it.each([false, true])('delivers the admitted end when a successor starts between polls (ends: %s)', async (ends) => {
    const f = await fixture();
    try {
      expect((await f.stream.next()).value).toMatchObject({ type: 'admission' });
      f.end('job', 20);
      f.request('job', 30);
      if (ends) f.end('job', 40);
      const events = [];
      for (;;) {
        const next = await f.stream.next();
        if (next.done) break;
        const event = parseWaitStreamEventValue(next.value);
        if (event === null) throw new Error('Expected wait stream event');
        events.push(event);
      }
      expect(events.filter((event) => event.type === 'terminal')).toMatchObject([
        { execution: 1, seq: 20, result: { content: 'job#1' } },
      ]);
      expect(events.some((event) => event.type === 'disposition')).toBe(false);
      expect(f.attention.isUnwaited('job', 1)).toBe(true);
    } finally {
      await f.stream.return?.();
    }
  });

  it('cancels a pending quiet poll and releases attention on transport disconnect', async () => {
    const f = await fixture();
    vi.mocked(f.time.sleep).mockRestore();
    expect(Object.getOwnPropertyDescriptor(f.waitRequest, 'abortSignal')).toMatchObject({
      enumerable: false,
      value: f.controller.signal,
    });
    expect((await f.stream.next()).value).toMatchObject({ type: 'admission' });
    expect(f.attention.isUnwaited('job', 1)).toBe(false);
    const pending = f.stream.next();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await flushMicrotasks(30);
      expect(settled).toBe(false);
      f.controller.abort();
      await flushMicrotasks(30);
      expect(settled).toBe(true);
      expect(f.attention.isUnwaited('job', 1)).toBe(true);
      expect(await pending).toMatchObject({ done: true });
    } finally {
      f.time.tick(600_000);
      await pending;
      await f.stream.return?.();
    }
  });
});
