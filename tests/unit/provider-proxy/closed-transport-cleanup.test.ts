import { describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { buildClaudeProviderServerSpec } from '#src/providers/claude/request-mapping.js';
import { createProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import type {
  ProviderServerCloseDisposition,
  ProviderServerHandle,
  spawnProviderServerTransport,
} from '#src/providers/app-server-transport.js';
import { createProviderHostDiagnostics, inspectProviderHostDiagnostics } from '#src/providers/host-diagnostics.js';

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('#src/providers/app-server-transport.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  spawnProviderServerTransport: transport.spawn,
}));

describe.each(['codex', 'claude'] as const)('closed shared %s transport cleanup', (provider) => {
  it.each(['live', 'held-alive', 'held-unobservable', 'absent', 'retired'] as const)(
    'requires exact absence and never abandons cleanup: %s',
    async (scenario) => {
      const runtime = new SimulationRuntime();
      runtime.process.readProcessIncarnation = () => testIncarnation('owned-host');
      let closed = false;
      const abandon = vi.fn();
      const observation = scenario === 'held-alive' ? 'alive' : 'unobservable';
      const cleanup = scenario.startsWith('held-')
        ? {
            kind: scenario,
            observation,
            subject: { kind: 'process', pid: 4242 },
            operatorExit: { kind: 'abandon-provider-host-acquisition', abandon },
            successor: {
              kind: 'accepted',
              owner: 'provider-proxy-root-pool',
              settlement: new Promise<void>(() => {}),
            },
          }
        : { kind: 'observed-absent', evidence: { subject: { kind: 'process', pid: 4242 } } };
      const close = vi.fn(async () => cleanup as ProviderServerCloseDisposition);
      const request = vi.fn().mockRejectedValue(new Error('transport permanently closed'));
      let confirmCessation!: () => void;
      const processCessation = new Promise<void>((resolve) => {
        confirmCessation = resolve;
      });
      const handle = {
        pid: 4242,
        isClosed: () => closed,
        close,
        closePromise: new Promise<void>(() => {}),
        processCessation,
        markExpectedClose: vi.fn(),
        rpc: { request, notify: vi.fn() },
        onNotification: () => () => {},
        inspectDiagnostics: () => inspectProviderHostDiagnostics(createProviderHostDiagnostics()),
      } as unknown as ProviderServerHandle;
      transport.spawn.mockResolvedValue(handle);
      const authority = createProxyAppServerHostAuthority(runtime);
      const scope = authority.beginOperation({ jobId: 'job-1', operationId: 'operation-1' });
      scope.selectCancellationMode('shared-acknowledged-interrupt');
      const cwd = fixtureCanonicalWorkDir(process.cwd());
      const spec =
        provider === 'claude'
          ? buildClaudeProviderServerSpec({
              command: 'fake-provider',
              args: [],
              cwd,
              environment: {},
              transportMode: 'print',
            })
          : {
              provider: 'codex',
              command: 'fake-provider',
              args: [],
              cwd,
              idleRetirement: 'unleased' as const,
              leaseMode: 'shared' as const,
            };
      const session = await scope.openSession(spec);
      await expect(authority.forceClose(session.hostRef)).rejects.toThrow(
        'provider_host_scope_shared_force_close_forbidden',
      );
      closed = scenario !== 'live';
      if (scenario === 'retired') {
        confirmCessation();
        await processCessation;
        expect(authority.listProviderHosts()).toEqual([]);
        expect(authority.terminalEviction(session.hostRef)).toBeNull();
        await expect(
          authority.closeObservedTransport({ ...session.hostRef, instanceId: 'replacement-host' }),
        ).resolves.toEqual({ kind: 'stale' });
      }
      if (scenario === 'live') {
        await expect(authority.closeObservedTransport(session.hostRef)).resolves.toBeUndefined();
        expect(close).not.toHaveBeenCalled();
      } else if (scenario.startsWith('held-')) {
        await expect(authority.closeObservedTransport(session.hostRef)).resolves.toMatchObject({
          kind: 'held',
          observation,
          successorOwner: 'provider-proxy-root-pool',
          operatorExit: 'abandon-provider-host-acquisition',
        });
        const snapshot = authority.admissionSnapshot();
        expect([...snapshot.state.values()]).toEqual([expect.objectContaining({ ref: session.hostRef })]);
        expect(snapshot.tombstones).toHaveLength(0);
        close.mockResolvedValueOnce({
          kind: 'observed-absent',
          evidence: { subject: { kind: 'process', pid: 4242 } },
        });
        await expect(authority.closeObservedTransport(session.hostRef)).resolves.toEqual({ kind: 'evicted' });
        expect(close).toHaveBeenCalledTimes(2);
      } else {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(authority.closeObservedTransport(session.hostRef)).resolves.toEqual({ kind: 'evicted' });
        }
        if (scenario === 'retired') expect(close).not.toHaveBeenCalled();
        else expect(close).toHaveBeenCalledTimes(1);
      }
      expect(request).not.toHaveBeenCalled();
      expect(abandon).not.toHaveBeenCalled();
    },
  );
});

it('keeps a blocked proxy host blocked after cessation until administrative eviction', async () => {
  const runtime = new SimulationRuntime();
  runtime.process.readProcessIncarnation = () => testIncarnation('blocked-host');
  let closed = false;
  let confirmCessation!: () => void;
  const processCessation = new Promise<void>((resolve) => {
    confirmCessation = resolve;
  });
  const handle = {
    pid: 4242,
    isClosed: () => closed,
    close: vi.fn(),
    closePromise: new Promise<void>(() => {}),
    processCessation,
    markExpectedClose: vi.fn(),
    rpc: { request: vi.fn(), notify: vi.fn() },
    onNotification: () => () => {},
    inspectDiagnostics: () => inspectProviderHostDiagnostics(createProviderHostDiagnostics()),
  } as unknown as ProviderServerHandle;
  const replacementHandle = {
    ...handle,
    pid: 4343,
    isClosed: () => false,
    processCessation: new Promise<void>(() => {}),
  };
  transport.spawn.mockReset().mockResolvedValueOnce(handle).mockResolvedValue(replacementHandle);
  const authority = createProxyAppServerHostAuthority(runtime);
  const spec = {
    provider: 'codex',
    command: 'fake-provider',
    args: [],
    cwd: fixtureCanonicalWorkDir(process.cwd()),
    idleRetirement: 'unleased' as const,
    leaseMode: 'shared' as const,
  };
  const scope = authority.beginOperation({ jobId: 'blocked-job', operationId: 'blocked-operation' });
  scope.selectCancellationMode('shared-acknowledged-interrupt');
  const session = await scope.openSession(spec);
  const spawned = transport.spawn.mock.calls[0][0] as Parameters<typeof spawnProviderServerTransport>[0];
  spawned.observeProviderResponse({
    factSeq: 1,
    generation: spawned.generation,
    requestId: 1,
    method: 'config/read',
    response: { kind: 'failure', rpcCode: -32603, providerMessage: 'unserviceable', providerData: null },
    hostLog: { startSeq: 0, endSeq: 0 },
  });
  closed = true;
  confirmCessation();
  await processCessation;
  transport.spawn.mockClear();
  const replacement = authority.beginOperation({ jobId: 'replacement-job', operationId: 'replacement-operation' });
  replacement.selectCancellationMode('shared-acknowledged-interrupt');
  await expect(replacement.openSession(spec)).rejects.toMatchObject({
    code: 'provider_host_unserviceable',
    hostRef: session.hostRef,
  });
  expect(transport.spawn).not.toHaveBeenCalled();
  expect(authority.terminalEviction(session.hostRef)).toBeNull();
  await expect(authority.evictHost(session.hostRef)).resolves.toEqual({ kind: 'evicted' });
  const admitted = await replacement.openSession(spec);
  expect(admitted.hostRef.instanceId).not.toBe(session.hostRef.instanceId);
});
