import { receiveSuccessionAttemptChild } from '#src/coordinator/succession/attempt-child.js';
import { createRealSuccessionAttemptPorts } from '#src/runtime/succession-attempt.js';
import { createIpcServer } from '#src/transport/ipc/server.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

/** The real attempt child adopting a real IPC listener; it serves nothing, so every connection it gets is parked. */
async function main(): Promise<void> {
  const child = await receiveSuccessionAttemptChild(createRealSuccessionAttemptPorts());
  if (child === null) throw new Error('The fixture runs only as a succession attempt child.');
  const listener = createIpcServer({ identity: { log: () => undefined } } as unknown as HttpHandlerPorts);
  await child.adoptListeners(listener);
}

void main();
