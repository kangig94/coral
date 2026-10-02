import { formatError } from '../../../infra/error-format.js';
import type { KbDaemonSupervisorState } from './state.js';
import { appendBuffer } from '../../../infra/process-supervision.js';
import type { requirePipedHandles } from '../../../infra/process-supervision.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { KbDaemonProtocolBindings, KbDaemonWireTypes } from './index.js';
type KbDaemonEventMessage = KbDaemonWireTypes['eventMessage'];
type KbDaemonParentRequestMessage = KbDaemonWireTypes['parentRequestMessage'];
import { createKbDaemonStdoutReceiver } from './stdout.js';
import type { DaemonProcessLike } from './index.js';

type ReadyDependencies = Readonly<{
  startTimeoutMs: number;
  onEvent: ((message: KbDaemonEventMessage) => void) | undefined;
  log: (message: string) => void;
  handleParentRequest: (
    request: KbDaemonParentRequestMessage,
    target: DaemonProcessLike,
    requestGeneration: number,
  ) => void;
  forwardDaemonStderrLine: (line: string) => void;
  rejectPendingRequests: (message: string, activeGeneration?: number) => void;
  abortActiveParentRequests: (reason: string, activeGeneration?: number) => void;
  notifyExitListeners: () => void;
  daemonExitDiagnostic: (stderr: string) => string;
}>;

export async function awaitKbDaemonReady(
  runtime: Runtime,
  state: KbDaemonSupervisorState,
  spawned: DaemonProcessLike,
  pipedHandles: ReturnType<typeof requirePipedHandles>,
  dependencies: ReadyDependencies,
  protocol: KbDaemonProtocolBindings,
): Promise<'ready' | 'closed' | 'error' | 'timeout'> {
  const {
    startTimeoutMs,
    onEvent,
    log,
    handleParentRequest,
    forwardDaemonStderrLine,
    rejectPendingRequests,
    abortActiveParentRequests,
    notifyExitListeners,
    daemonExitDiagnostic,
  } = dependencies;
  state.daemonProcess = spawned;
  state.pid = spawned.pid ?? null;
  const activeGeneration = state.generation;
  const startedAtForExit = state.startedAt;
  const { stdin, stdout, stderr } = pipedHandles;
  stdout.setEncoding('utf-8');
  stderr.setEncoding('utf-8');

  stdin.on('error', (error: unknown) => {
    log(`[kb-daemon] stdin error: ${formatError(error)}`);
  });

  const readyPromise = new Promise<'ready' | 'closed' | 'error' | 'timeout'>((resolve) => {
    let settled = false;
    const settle = (result: 'ready' | 'closed' | 'error' | 'timeout'): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timeout = runtime.time.setTimeout(() => {
      settle('timeout');
    }, startTimeoutMs);
    timeout.unref?.();

    stdout.on(
      'data',
      createKbDaemonStdoutReceiver(
        runtime,
        state,
        spawned,
        activeGeneration,
        timeout,
        settle,
        onEvent,
        log,
        handleParentRequest,
        protocol,
      ),
    );

    stderr.on('data', (chunk) => {
      const text = String(chunk);
      state.stderrBuffer = appendBuffer(state.stderrBuffer, text);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          forwardDaemonStderrLine(trimmed);
        }
      }
    });

    spawned.on('error', (error) => {
      state.lastError = `daemon process error: ${formatError(error)}`;
      state.lastSetupError = undefined;
      runtime.time.clearTimeout(timeout);
      settle('error');
    });

    spawned.on('close', (code, signal) => {
      runtime.time.clearTimeout(timeout);
      state.lastExit = {
        code,
        signal,
        at: runtime.time.now(),
        uptimeMs: startedAtForExit === null ? null : Math.max(0, runtime.time.now() - startedAtForExit),
      };
      if (state.daemonProcess === spawned) {
        state.daemonProcess = null;
        state.pid = null;
        state.readyAt = null;
        rejectPendingRequests('KB daemon exited', activeGeneration);
        abortActiveParentRequests('KB daemon exited', activeGeneration);
        if (state.phase === 'stopping') {
          state.phase = 'stopped';
        } else {
          state.phase = 'failed';
          state.lastError = daemonExitDiagnostic(state.stderrBuffer);
          state.lastSetupError = undefined;
        }
        notifyExitListeners();
      }
      settle('closed');
    });
  });

  return await readyPromise;
}
