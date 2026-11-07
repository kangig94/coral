import { beforeEach, expect, it, vi } from 'vitest';
import type * as ClockModule from '#src/infra/monotonic-clock.js';
import type * as ProofModule from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import { createProviderProxySetRecordedContainmentReaper } from '#src/coordinator/services/provider-proxy-set/recorded-containment-reaper.js';
import type { ProviderProxySetFencedContainmentProof } from '#src/coordinator/services/provider-proxy-set/containment-proof.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';
import { ProcessContainmentInvariantError } from '#src/infra/process-containment.js';
import { MAX_PROXY_RECORDED_PROVIDER_ROOTS } from '#src/provider-proxy/enforcement.js';
import { PROXY_TEARDOWN_RESERVE_MS } from '#src/provider-proxy/orphan-deadline.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const state = vi.hoisted(() => ({ milliseconds: 0n, rootCount: 0 }));
vi.mock('#src/infra/monotonic-clock.js', async (original) => {
  const actual = await original<typeof ClockModule>();
  return {
    ...actual,
    createMonotonicClock: (scope: symbol) =>
      actual.createMonotonicClock(scope, {
        readMilliseconds: () => state.milliseconds,
        sleep: async (ms) => {
          state.milliseconds += BigInt(ms);
        },
      }),
  };
});
vi.mock('#src/coordinator/services/provider-proxy-set/containment-proof.js', async (original) => ({
  ...(await original<typeof ProofModule>()),
  providerProxySetContainmentEvidenceFor: () => ({
    kind: 'reap-required',
    containment: { pid: 100, processGroupId: 100, incarnation: testIncarnation(1) },
    recordedRoots: Array.from({ length: state.rootCount }, () => ({ pid: 101, incarnation: testIncarnation(2) })),
  }),
  verifyProviderProxySetContainmentProofCurrent: () => ({ kind: 'current' }),
}));

const identity = { proxyInstanceId: 'deadline-test' } as ProviderProxySetIdentity;
const proof = {} as ProviderProxySetFencedContainmentProof;
beforeEach(() => {
  state.milliseconds = 0n;
  state.rootCount = 0;
});

it.each([false, true])(
  'holds an observation past its deadline and permits a fresh observation (signalled=%s)',
  async (signalled) => {
    const runtime = new SimulationRuntime();
    let overrunPending = !signalled;
    let absent = !signalled;
    state.rootCount = signalled ? 1 : 0;
    runtime.process.observeRecordedProcessAsync = vi.fn(async () => {
      if (overrunPending) {
        overrunPending = false;
        state.milliseconds += BigInt(PROXY_TEARDOWN_RESERVE_MS + 1);
      }
      return absent ? 'absent' : 'alive';
    });
    vi.spyOn(runtime.process, 'observeLiveness').mockImplementation(() => (absent ? 'absent' : 'alive'));
    vi.spyOn(runtime.process, 'readProcessIncarnation').mockImplementation((pid) =>
      absent ? null : testIncarnation(pid === 100 ? 1 : 2),
    );
    vi.spyOn(runtime.process, 'kill').mockReturnValue(true);
    const onSignal = vi.fn(() => {
      overrunPending = true;
    });
    const reap = createProviderProxySetRecordedContainmentReaper(runtime);
    expect(await reap(identity, proof, new AbortController().signal, onSignal)).toEqual({
      kind: 'identity-unobservable',
      signalDelivered: signalled,
    });
    expect(onSignal).toHaveBeenCalledTimes(signalled ? 1 : 0);
    absent = true;
    expect(await reap(identity, proof, new AbortController().signal, onSignal)).toMatchObject({
      kind: 'containment-absent',
    });
  },
);

it('preserves an invariant violation despite its shared reap-failed error code', async () => {
  state.rootCount = MAX_PROXY_RECORDED_PROVIDER_ROOTS + 1;
  const reap = createProviderProxySetRecordedContainmentReaper(new SimulationRuntime());
  const result = reap(identity, proof, new AbortController().signal, () => {});
  await expect(result).rejects.toBeInstanceOf(ProcessContainmentInvariantError);
  await expect(result).rejects.toMatchObject({
    name: 'ProcessContainmentError',
    code: 'process_containment_reap_failed',
  });
});

it('preserves caller cancellation when an observation overruns its deadline', async () => {
  const runtime = new SimulationRuntime();
  const abort = new AbortController();
  const reason = new Error('caller cancelled');
  runtime.process.observeRecordedProcessAsync = async () => {
    state.milliseconds += BigInt(PROXY_TEARDOWN_RESERVE_MS + 1);
    abort.abort(reason);
    return 'absent';
  };
  const reap = createProviderProxySetRecordedContainmentReaper(runtime);
  await expect(reap(identity, proof, abort.signal, () => {})).rejects.toBe(reason);
});
