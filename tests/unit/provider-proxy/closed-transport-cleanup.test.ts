import { describe, expect, it, vi } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { buildClaudeProviderServerSpec } from '#src/providers/claude/request-mapping.js';
import { createProxyAppServerHostAuthority } from '#src/provider-proxy/provider-root-authority.js';
import type { ProviderServerCloseDisposition, ProviderServerHandle } from '#src/providers/app-server-transport.js';
import { createProviderHostDiagnostics, inspectProviderHostDiagnostics } from '#src/providers/host-diagnostics.js';

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('#src/providers/app-server-transport.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  spawnProviderServerTransport: transport.spawn,
}));

describe.each(['codex', 'claude'] as const)('closed shared %s transport cleanup', (provider) => {
  it.each(['live', 'held-alive', 'held-unobservable', 'absent'] as const)(
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
      const handle = {
        pid: 4242,
        isClosed: () => closed,
        close,
        closePromise: new Promise<void>(() => {}),
        processCessation: new Promise<void>(() => {}),
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
        expect(close).toHaveBeenCalledTimes(1);
      }
      expect(request).not.toHaveBeenCalled();
      expect(abandon).not.toHaveBeenCalled();
    },
  );
});
