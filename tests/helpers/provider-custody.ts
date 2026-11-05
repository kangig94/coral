import type { EventEmitter } from 'node:events';
import type { SimulationRuntime } from '#tools/simulation/runtime.js';
import type { MockSpawnScript } from '#tools/simulation/core/mock-script-types.js';
export const providerCustodyTicket = JSON.stringify({
  runDir: '/run',
  epoch: '/epoch-1',
  intentId: '00000000-0000-4000-8000-000000000002',
  processToken: '00000000-0000-4000-8000-000000000001',
  processGroupId: null,
});

export function enqueueProviderHost(runtime: SimulationRuntime, script: MockSpawnScript): void {
  runtime.spawner.enqueueSpawn({
    ...script,
    onSpawn: (context) => {
      script.onSpawn?.(context);
      context.child.on('exit', () =>
        (context.child as unknown as EventEmitter).emit('message', {
          kind: 'provider-host-absent',
          processToken: JSON.parse(providerCustodyTicket).processToken as string,
        }),
      );
    },
  });
}
