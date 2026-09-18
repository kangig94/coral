declare const __PLUGIN_ROOT__: string;

import { createReadStream } from 'node:fs';

import { createBootstrapProbeExitGate } from '#src/coordinator/bootstrap.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';

const exitGate = createBootstrapProbeExitGate();
let triggerFatal: ((error: unknown) => void) | undefined;

const coordinator = createCoordinatorServer({
  pluginRoot: __PLUGIN_ROOT__,
  captureProviderProxyLifecycleFatal: (handler) => {
    triggerFatal = handler;
  },
  handoffDrainBudgetMs: 150,
  onStopped: (exitCode) => exitGate.requestExit(exitCode),
  acceptProcessExitRemainder: (remainder) => ({
    kind: 'accepted',
    remainder,
    requestExit: (exitCode) => exitGate.requestExit(exitCode),
  }),
  onFatalShutdownError: (error) => {
    console.error('Fatal shutdown error', error);
    exitGate.requestExit(1);
  },
});

const fatal = triggerFatal;
if (fatal === undefined) {
  throw new Error('Coordinator composition did not expose its provider-proxy lifecycle fatal callback.');
}

// Inherited fd 3 is the only test trigger; shipped inputs cannot select this path.
const trigger = createReadStream('/dev/null', { fd: 3, autoClose: true });
trigger.once('data', () => {
  trigger.once('close', () => fatal(new Error('deterministic corrupt provider-proxy lifecycle evidence')));
  trigger.destroy();
});

void coordinator.start().catch((error: unknown) => {
  console.error('Fatal startup error', error);
  exitGate.requestExit(1);
});
