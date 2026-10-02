import { formatError } from '../../../infra/error-format.js';
import type { KbDaemonSupervisorState } from './state.js';
import type { KbDaemonProtocolBindings, KbDaemonWireTypes } from './index.js';
type KbDaemonEventMessage = KbDaemonWireTypes['eventMessage'];
type KbDaemonParentRequestMessage = KbDaemonWireTypes['parentRequestMessage'];
import type { Runtime } from '../../../runtime/ports.js';
import type { DaemonProcessLike } from './index.js';

export function createKbDaemonStdoutReceiver(
  runtime: Runtime,
  state: KbDaemonSupervisorState,
  spawned: DaemonProcessLike,
  activeGeneration: number,
  timeout: ReturnType<Runtime['time']['setTimeout']>,
  settle: (result: 'ready' | 'closed' | 'error' | 'timeout') => void,
  onEvent: ((message: KbDaemonEventMessage) => void) | undefined,
  log: (message: string) => void,
  handleParentRequest: (
    request: KbDaemonParentRequestMessage,
    target: DaemonProcessLike,
    requestGeneration: number,
  ) => void,
  protocol: KbDaemonProtocolBindings,
): (chunk: unknown) => void {
  const { isKbDaemonEventMessage, isKbDaemonParentRequestMessage, isKbDaemonReadyMessage, isKbDaemonResponseMessage } =
    protocol;
  let lineBuffer = '';
  return (chunk: unknown) => {
    lineBuffer += String(chunk);
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isKbDaemonReadyMessage(parsed)) {
          if (activeGeneration === state.generation && state.daemonProcess === spawned) {
            state.pid = parsed.pid;
            state.readyAt = parsed.readyAt;
            state.phase = 'online';
          }
          runtime.time.clearTimeout(timeout);
          settle('ready');
          continue;
        }
        if (isKbDaemonResponseMessage(parsed)) {
          const pending = state.pendingRequests.get(parsed.id);
          if (pending !== undefined) {
            runtime.time.clearTimeout(pending.timeout);
            state.pendingRequests.delete(parsed.id);
            pending.resolve(parsed);
          }
          continue;
        }
        if (isKbDaemonEventMessage(parsed)) {
          try {
            onEvent?.(parsed);
          } catch (error: unknown) {
            log(`[kb-daemon] event callback failed: ${formatError(error)}`);
          }
          continue;
        }
        if (isKbDaemonParentRequestMessage(parsed)) {
          handleParentRequest(parsed, spawned, activeGeneration);
          continue;
        }
      } catch {
        // Non-control output must not interrupt later control replies.
      }
    }
  };
}
