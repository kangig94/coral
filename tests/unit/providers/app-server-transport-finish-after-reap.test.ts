import type { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { spawnProviderServerTransport } from '#src/providers/app-server-transport.js';
import { SimulationRuntime } from '#tools/simulation/runtime.js';
import { flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { enqueueProviderHost, providerCustodyTicket } from '#tests/helpers/provider-custody.js';

it('joins actual leaf-aware cessation after transport closure in finishCloseAfterReap', async () => {
  const runtime = new SimulationRuntime();
  let populated = true;
  vi.spyOn(runtime.process, 'failureDomainContainment').mockReturnValue({
    observe: () => ({ kind: populated ? ('populated' as const) : ('absent' as const) }),
    kill: () => ({ kind: 'refused', errno: 'EACCES' }),
  });
  let closeProcess!: () => void;
  enqueueProviderHost(runtime, {
    close: null,
    onSpawn: (context) => {
      closeProcess = () => context.close({ code: 0 });
      const ticket = JSON.parse(providerCustodyTicket) as {
        runDir: string;
        intentId: string;
        processToken: string;
        epoch: string;
      };
      const dir = `${ticket.runDir}/custody.v1/${ticket.intentId}`;
      runtime.storage.mkdirSync(dir, { recursive: true });
      runtime.storage.writeAtomicSync(
        `${dir}/intent.v1.json`,
        JSON.stringify({
          version: 'v1',
          id: ticket.intentId,
          effect: 'process-spawn',
          owner: 'provider-host',
          operationId: 'test',
          epoch: ticket.epoch,
          processToken: ticket.processToken,
          capsule: null,
          createdAtMs: 0,
          bindDeadlineMs: 100_000,
        }),
      );
      runtime.storage.writeAtomicSync(
        `${dir}/binding.v1.json`,
        JSON.stringify({
          version: 'v1',
          intentId: ticket.intentId,
          processToken: ticket.processToken,
          operationId: 'test',
          process: {
            pid: context.child.pid,
            incarnation: runtime.process.readProcessIncarnation(context.child.pid!, 'linux'),
            processGroupId: context.child.pid,
          },
          capsule: null,
          observedAtMs: 0,
        }),
      );
    },
  });
  const handle = await spawnProviderServerTransport({
    runtime,
    detached: true,
    generation: 1,
    options: {
      custodyTicket: providerCustodyTicket,
      provider: 'test',
      command: 'fixture',
      args: [],
      failureDomainName: 'host-test',
    },
    observeProviderResponse: () => {},
    acceptFailedSpawnCleanup: (hold) => ({
      kind: 'accepted',
      owner: 'provider-host-manager',
      settlement: hold.settled,
    }),
  });
  if ('kind' in handle) throw handle.error;
  let finished = false;
  const finish = handle.finishCloseAfterReap().then(() => {
    finished = true;
  });
  (handle.child as unknown as EventEmitter).emit(
    'error',
    new Error('synthetic transport closure before process cessation'),
  );
  await handle.closePromise;
  await flushMicrotasks(64);
  expect(finished).toBe(false);

  closeProcess();
  await flushMicrotasks(64);
  expect(runtime.process.observeLiveness(handle.pid)).toBe('absent');
  expect(finished).toBe(false);

  populated = false;
  runtime.time.tick(25);
  await flushMicrotasks(64);
  expect(finished).toBe(true);
  await finish;
});
