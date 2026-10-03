import { formatError } from '../../../infra/error-format.js';
import type { KbDaemonSupervisorState } from './state.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { SerializedCoralSetupError } from '../../../runtime/errors.js';
import type { KbDaemonHealthSnapshot } from './index.js';

export function createKbDaemonHealth(
  runtime: Runtime,
  entrypoint: string,
  log: (message: string) => void,
  state: KbDaemonSupervisorState,
) {
  const forwardDaemonStderrLine = (line: string): void => {
    if (line === state.lastStderrLine) {
      state.repeatedStderrLines += 1;
      return;
    }
    if (state.repeatedStderrLines > 0) {
      log(`[kb-daemon] previous line repeated ${state.repeatedStderrLines} more time(s)`);
      state.repeatedStderrLines = 0;
    }
    state.lastStderrLine = line;
    log(`[kb-daemon] ${line}`);
  };

  const read = (): KbDaemonHealthSnapshot => ({
    enabled: true,
    phase: state.phase,
    childPresence: state.daemonProcess === null ? 'absent' : 'present',
    generation: state.generation,
    pid: state.pid,
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    entrypoint,
    pendingRequests: state.pendingRequests.size,
    ...(state.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: state.lastHeartbeatAt }),
    ...(state.lastHeartbeatLatencyMs === undefined ? {} : { lastHeartbeatLatencyMs: state.lastHeartbeatLatencyMs }),
    ...(state.daemonUptimeMs === undefined ? {} : { daemonUptimeMs: state.daemonUptimeMs }),
    ...(state.kbReadHealth === undefined ? {} : { kbRead: state.kbReadHealth }),
    ...(state.kbWriteHealth === undefined ? {} : { kbWrite: state.kbWriteHealth }),
    ...(state.lastExit === undefined ? {} : { lastExit: state.lastExit }),
    ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    ...(state.lastSetupError === undefined ? {} : { setupError: state.lastSetupError }),
  });

  const setFailure = (message: string, setupError?: SerializedCoralSetupError): void => {
    state.lastError = message;
    state.lastSetupError = setupError;
    state.phase = 'failed';
    log(`[kb-daemon] ${message}`);
  };
  const notifyExitListeners = (): void => {
    const snapshot = read();
    for (const listener of state.exitListeners) {
      try {
        listener(snapshot);
      } catch (error: unknown) {
        log(`[kb-daemon] exit listener failed: ${formatError(error)}`);
      }
    }
  };

  return { forwardDaemonStderrLine, read, setFailure, notifyExitListeners };
}
