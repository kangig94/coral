import { createServer } from 'node:net';

import type { LifecycleDeps } from '#src/coordinator/lifecycle.js';

type BoundIpcLifecycleDeps = Required<Pick<LifecycleDeps, 'ipcServer' | 'closeIpcServerFn' | 'listenIpcFn'>>;

export function createBoundIpcLifecycleDeps(): BoundIpcLifecycleDeps {
  return {
    ipcServer: {
      server: createServer(),
      sockets: new Set(),
      socketPath: null,
      onShutdownRequest: () => {},
    },
    closeIpcServerFn: async () => {},
    listenIpcFn: async () => ({ kind: 'bound', socketPath: 'bound-test-coordinator.sock' }),
  };
}
