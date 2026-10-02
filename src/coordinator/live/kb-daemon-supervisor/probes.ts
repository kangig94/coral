import { errorMessage } from '../../../infra/error-format.js';
import type { KbDaemonSupervisorState } from './state.js';
import type { KbDaemonProtocolBindings } from './index.js';
import { serializeCoralSetupError, type SerializedCoralSetupError } from '../../../runtime/errors.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { KbDaemonDisposalSettlement, KbDaemonHealthSnapshot, KbDaemonPhase } from './index.js';
import type { createKbDaemonRequests } from './requests.js';

type ProbeDependencies = Pick<ReturnType<typeof createKbDaemonRequests>, 'sendRequest' | 'runExclusive'> &
  Readonly<{
    setFailure: (message: string, setupError?: SerializedCoralSetupError) => void;
    read: () => KbDaemonHealthSnapshot;
    startNow: () => Promise<KbDaemonHealthSnapshot>;
    stopNow: (reason: string) => Promise<KbDaemonDisposalSettlement>;
  }>;

export function createKbDaemonProbes(
  runtime: Runtime,
  state: KbDaemonSupervisorState,
  dependencies: ProbeDependencies,
  protocol: KbDaemonProtocolBindings,
) {
  const { isKbDaemonHealthResult, isKbDaemonKbReadHealth } = protocol;
  const { sendRequest, setFailure, read, runExclusive, startNow, stopNow } = dependencies;
  const probeNow = async (): Promise<KbDaemonHealthSnapshot> => {
    try {
      const response = await sendRequest('health');
      if (!response.ok) {
        setFailure(`health probe failed: ${response.error.message}`, response.error.setupError);
        return read();
      }
      if (!isKbDaemonHealthResult(response.result)) {
        setFailure('health probe returned malformed result');
        return read();
      }
      state.lastHeartbeatAt = runtime.time.now();
      state.lastError = undefined;
      state.lastSetupError = undefined;
      state.daemonUptimeMs = response.result.uptimeMs;
      state.kbReadHealth = response.result.kbRead;
      state.kbWriteHealth = response.result.kbWrite;
      state.pid = response.result.pid;
      return read();
    } catch (error: unknown) {
      state.lastError = `health probe failed: ${errorMessage(error)}`;
      state.lastSetupError = serializeCoralSetupError(error) ?? undefined;
      return read();
    }
  };

  const probeExclusive = (): Promise<KbDaemonHealthSnapshot> => {
    if (state.probeOperation !== null) {
      return state.probeOperation;
    }
    const running = runExclusive(probeNow);
    const tracked = running.finally(() => {
      if (state.probeOperation === tracked) {
        state.probeOperation = null;
      }
    });
    state.probeOperation = tracked;
    return tracked;
  };

  const warmupNow = async (): Promise<KbDaemonHealthSnapshot> => {
    try {
      const response = await sendRequest('kb.warmup');
      if (!response.ok) {
        setFailure(`warmup failed: ${response.error.message}`, response.error.setupError);
        return read();
      }
      if (!isKbDaemonKbReadHealth(response.result)) {
        setFailure('warmup returned malformed KB read health');
        return read();
      }
      state.lastHeartbeatAt = runtime.time.now();
      state.kbReadHealth = response.result;
      return read();
    } catch (error: unknown) {
      state.lastError = `warmup failed: ${errorMessage(error)}`;
      state.lastSetupError = serializeCoralSetupError(error) ?? undefined;
      return read();
    }
  };

  const recoverForRequest = async (
    failedGeneration: number,
    failedPhase: KbDaemonPhase,
    reason: string,
  ): Promise<KbDaemonHealthSnapshot> =>
    runExclusive(async () => {
      if (!state.requestRecoveryEnabled || state.disposed) {
        return read();
      }
      if (
        state.phase === 'online' &&
        state.daemonProcess !== null &&
        (state.generation !== failedGeneration || failedPhase !== 'online')
      ) {
        return read();
      }
      if (state.daemonProcess !== null) {
        state.phase = 'restarting';
        void (await stopNow(reason));
        if (state.daemonProcess !== null) {
          return read();
        }
      }
      return startNow();
    });

  return { probeExclusive, warmupNow, recoverForRequest };
}
