import { errorMessage, formatError } from '../../../infra/error-format.js';
import type { KbDaemonSupervisorState } from './state.js';
import { serializeCoralSetupError } from '../../../runtime/errors.js';
import type { KbDaemonProtocolBindings, KbDaemonWireTypes } from './index.js';
type KbDaemonErrorEnvelope = KbDaemonWireTypes['errorEnvelope'];
type KbDaemonParentRequestMessage = KbDaemonWireTypes['parentRequestMessage'];
import type { DaemonProcessLike, KbDaemonCurateAssistantHandler, KbDaemonCurateUsageBudgetHandler } from './index.js';

type ParentResponseWriter = (
  target: DaemonProcessLike,
  message: { id: string; ok: true; result: unknown } | { id: string; ok: false; error: KbDaemonErrorEnvelope },
) => void;

function settleActiveParentRequest<Result>(
  state: KbDaemonSupervisorState,
  request: KbDaemonParentRequestMessage,
  target: DaemonProcessLike,
  requestGeneration: number,
  writeParentResponse: ParentResponseWriter,
  handler: (signal: AbortSignal) => Promise<Result>,
): void {
  const controller = new AbortController();
  const key = `${requestGeneration}:${request.id}`;
  state.activeParentRequests.set(key, { generation: requestGeneration, controller });
  void Promise.resolve()
    .then(() => handler(controller.signal))
    .then((result) => {
      if (state.activeParentRequests.get(key)?.controller !== controller) return;
      writeParentResponse(target, { id: request.id, ok: true, result });
    })
    .catch((error: unknown) => {
      if (state.activeParentRequests.get(key)?.controller !== controller) return;
      const setupError = serializeCoralSetupError(error);
      writeParentResponse(target, {
        id: request.id,
        ok: false,
        error: {
          message: errorMessage(error),
          ...(setupError === null ? {} : { setupError }),
        },
      });
    })
    .finally(() => {
      if (state.activeParentRequests.get(key)?.controller === controller) state.activeParentRequests.delete(key);
    });
}

export function createKbDaemonParentRequests(
  state: KbDaemonSupervisorState,
  log: (message: string) => void,
  parentCurateAssistant: KbDaemonCurateAssistantHandler | undefined,
  parentCurateUsageBudget: KbDaemonCurateUsageBudgetHandler | undefined,
  protocol: KbDaemonProtocolBindings,
) {
  const {
    KB_DAEMON_PARENT_RESPONSE_MESSAGE,
    encodeKbDaemonMessage,
    isKbDaemonCurateRequestCancelRequest,
    isKbDaemonCurateAssistantCompleteRequest,
  } = protocol;
  const writeParentResponse = (
    target: DaemonProcessLike,
    message: { id: string; ok: true; result: unknown } | { id: string; ok: false; error: KbDaemonErrorEnvelope },
  ): void => {
    try {
      target.stdin?.write(
        encodeKbDaemonMessage({
          type: KB_DAEMON_PARENT_RESPONSE_MESSAGE,
          ...message,
        }),
      );
    } catch (error: unknown) {
      log(`[kb-daemon] failed to write parent response: ${formatError(error)}`);
    }
  };

  const parentRequestKey = (requestGeneration: number, id: string): string => `${requestGeneration}:${id}`;

  const abortActiveParentRequests = (reason: string, activeGeneration?: number): void => {
    for (const [key, entry] of state.activeParentRequests) {
      if (activeGeneration !== undefined && entry.generation !== activeGeneration) {
        continue;
      }
      entry.controller.abort(new Error(reason));
      state.activeParentRequests.delete(key);
    }
  };

  const handleParentRequest = (
    request: KbDaemonParentRequestMessage,
    target: DaemonProcessLike,
    requestGeneration: number,
  ): void => {
    const runActiveParentRequest = <Result>(handler: (signal: AbortSignal) => Promise<Result>): void =>
      settleActiveParentRequest(state, request, target, requestGeneration, writeParentResponse, handler);

    switch (request.method) {
      case 'curate.assistant.complete': {
        if (!isKbDaemonCurateAssistantCompleteRequest(request.params)) {
          writeParentResponse(target, {
            id: request.id,
            ok: false,
            error: { message: 'Malformed KB daemon curate assistant request.' },
          });
          return;
        }
        if (parentCurateAssistant === undefined) {
          writeParentResponse(target, {
            id: request.id,
            ok: false,
            error: { message: 'KB daemon curate assistant parent handler is not configured.' },
          });
          return;
        }
        const params = request.params;
        runActiveParentRequest((signal) => parentCurateAssistant(params, { signal }));
        return;
      }
      case 'curate.usage-budget.exhausted': {
        if (request.params !== undefined || parentCurateUsageBudget === undefined) {
          writeParentResponse(target, {
            id: request.id,
            ok: false,
            error: {
              message:
                request.params !== undefined
                  ? 'Malformed KB daemon curate usage budget request.'
                  : 'KB daemon curate usage budget parent handler is not configured.',
            },
          });
          return;
        }
        runActiveParentRequest((signal) => parentCurateUsageBudget({ signal }));
        return;
      }
      case 'curate.request.cancel': {
        if (!isKbDaemonCurateRequestCancelRequest(request.params)) {
          writeParentResponse(target, {
            id: request.id,
            ok: false,
            error: { message: 'Malformed KB daemon curate request cancel.' },
          });
          return;
        }
        const key = parentRequestKey(requestGeneration, request.params.requestId);
        const active = state.activeParentRequests.get(key);
        if (active !== undefined) {
          state.activeParentRequests.delete(key);
          active.controller.abort(
            new Error(request.params.reason ?? 'KB daemon canceled parent curate assistant request.'),
          );
        }
        writeParentResponse(target, { id: request.id, ok: true, result: { canceled: active !== undefined } });
        return;
      }
    }
  };

  return { abortActiveParentRequests, handleParentRequest };
}
