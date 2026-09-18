declare const __PLUGIN_ROOT__: string;

import { appendFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';

import { createBootstrapProbeExitGate } from '#src/coordinator/bootstrap.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';

const exitGate = createBootstrapProbeExitGate();
const actionPath = join(process.env.HOME ?? process.cwd(), 'fatal-drain-actions.log');
const recordAction = (action: string): void => appendFileSync(actionPath, `${action}\n`, 'utf-8');
let triggerFatal: ((error: unknown) => void) | undefined;
let fatalDuringHardDrain: Error | null = null;

function injectFatal(error: unknown): void {
  const fatal = triggerFatal;
  if (fatal === undefined) {
    throw new Error('Coordinator composition did not expose its provider-proxy lifecycle fatal callback.');
  }
  fatal(error);
}

const coordinator = createCoordinatorServer({
  pluginRoot: __PLUGIN_ROOT__,
  captureProviderProxyLifecycleFatal: (handler) => {
    triggerFatal = handler;
  },
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
    shutdown: async (signal: AbortSignal) => {
      recordAction('provider-host-hard-shutdown-started');
      const receipt = {
        kind: 'provider-hosts-quiesced',
        liveProxySets: [],
        acquisitionCleanupHolds: [],
        closingHosts: [],
      } as const;
      const error = fatalDuringHardDrain;
      if (error === null) return receipt;
      fatalDuringHardDrain = null;
      return await new Promise<typeof receipt>((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            recordAction('provider-host-hard-shutdown-aborted');
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
          },
          { once: true },
        );
        injectFatal(error);
        if (!signal.aborted) {
          recordAction('provider-host-hard-shutdown-continued-without-abort');
          resolve(receipt);
        }
      });
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

if (triggerFatal === undefined) {
  throw new Error('Coordinator composition did not expose its provider-proxy lifecycle fatal callback.');
}

// Inherited fd 3 is the only test trigger; shipped inputs cannot select this path.
const trigger = createReadStream('/dev/null', { fd: 3, autoClose: true });
trigger.once('data', (chunk: string | Buffer) => {
  trigger.once('close', () => {
    const error = new Error('deterministic corrupt provider-proxy lifecycle evidence');
    const triggerKind = typeof chunk === 'string' ? Buffer.from(chunk)[0] : chunk[0];
    if (triggerKind !== 2) {
      injectFatal(error);
      return;
    }
    fatalDuringHardDrain = error;
    void coordinator.shutdown('sigint').catch(() => undefined);
  });
  trigger.destroy();
});

void coordinator.start().catch((error: unknown) => {
  console.error('Fatal startup error', error);
  exitGate.requestExit(1);
});
