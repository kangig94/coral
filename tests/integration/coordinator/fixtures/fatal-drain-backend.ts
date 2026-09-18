declare const __PLUGIN_ROOT__: string;

import { appendFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';

import { createBootstrapProbeExitGate } from '#src/coordinator/bootstrap.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';
import { IdleTimer } from '#src/coordinator/live/idle.js';
import { createRealTimePort } from '#src/infra/time.js';

const exitGate = createBootstrapProbeExitGate();
const idleTimer = new IdleTimer({ time: createRealTimePort() });
const actionPath = join(process.env.HOME ?? process.cwd(), 'fatal-drain-actions.log');
const recordAction = (action: string): void => appendFileSync(actionPath, `${action}\n`, 'utf-8');
let triggerFatal: ((error: unknown) => void) | undefined;

const coordinator = createCoordinatorServer({
  pluginRoot: __PLUGIN_ROOT__,
  captureProviderProxyLifecycleFatal: (handler) => {
    triggerFatal = handler;
  },
  createIdleTimer: () => idleTimer,
  providerHostManager: {
    drainForHandoff: async () => {
      recordAction('provider-host-handoff-drain');
      return {
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      };
    },
    shutdown: async () => {
      recordAction('provider-host-hard-shutdown');
      return {
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      };
    },
  } as never,
  settlePendingLaunchesFn: () => {
    recordAction('pending-launch-settlement');
    return { kind: 'all-pending-launches-settled' };
  },
  terminateRegisteredChildrenFn: () => {
    recordAction('child-termination');
    return { kind: 'all-children-observed-absent' };
  },
  markJobsAsErrorFn: () => {
    recordAction('job-terminalization');
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
trigger.once('data', (chunk: string | Buffer) => {
  trigger.once('close', () => {
    const error = new Error('deterministic corrupt provider-proxy lifecycle evidence');
    const triggerKind = typeof chunk === 'string' ? Buffer.from(chunk)[0] : chunk[0];
    if (triggerKind !== 2) {
      fatal(error);
      return;
    }
    idleTimer.beginRequest();
    void coordinator.shutdown('sigint').catch(() => undefined);
    setTimeout(() => {
      fatal(error);
      idleTimer.endRequest();
    }, 50);
  });
  trigger.destroy();
});

void coordinator.start().catch((error: unknown) => {
  console.error('Fatal startup error', error);
  exitGate.requestExit(1);
});
