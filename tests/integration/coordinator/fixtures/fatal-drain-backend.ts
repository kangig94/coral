declare const __PLUGIN_ROOT__: string;

import { appendFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';

import { createBootstrapProbeExitGate } from '#src/coordinator/bootstrap.js';
import { createCoordinatorServer } from '#src/coordinator/index.js';

const exitGate = createBootstrapProbeExitGate();
const actionPath = join(process.env.HOME ?? process.cwd(), 'fatal-drain-actions.log');
const recordAction = (action: string): void => appendFileSync(actionPath, `${action}\n`, 'utf-8');
let triggerFatal: ((error: unknown) => void) | undefined;
let fatalDuringHardDrain: Readonly<{
  error: Error;
  timing: 'before-budget-exhaustion' | 'after-budget-exhaustion';
}> | null = null;

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
      const fatal = fatalDuringHardDrain;
      if (fatal === null) return receipt;
      fatalDuringHardDrain = null;
      if (fatal.timing === 'after-budget-exhaustion') {
        return await new Promise<typeof receipt>(() => {
          signal.addEventListener(
            'abort',
            () => {
              recordAction('provider-host-hard-shutdown-budget-expired');
              injectFatal(fatal.error);
            },
            { once: true },
          );
        });
      }
      return await new Promise<typeof receipt>((resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            recordAction('provider-host-hard-shutdown-aborted');
            reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
          },
          { once: true },
        );
        injectFatal(fatal.error);
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
      if (triggerKind === 3) {
        const cause = Object.assign(new Error('provider-host evidence was corrupt'), {
          code: 'CORRUPT_PROVIDER_HOST_EVIDENCE',
        });
        fatalDuringHardDrain = {
          error: Object.assign(new Error('fatal evidence arrived after the drain budget'), {
            name: 'AfterBudgetFatalError',
            code: 'FATAL_AFTER_BUDGET',
            cause,
          }),
          timing: 'after-budget-exhaustion',
        };
        void coordinator.shutdown('sigint').catch(() => undefined);
        return;
      }
      injectFatal(error);
      return;
    }
    fatalDuringHardDrain = { error, timing: 'before-budget-exhaustion' };
    void coordinator.shutdown('sigint').catch(() => undefined);
  });
  trigger.destroy();
});

void coordinator.start().catch((error: unknown) => {
  console.error('Fatal startup error', error);
  exitGate.requestExit(1);
});
