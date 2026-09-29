import { errorMessage } from '../../../infra/error-format.js';
import type { KbDaemonSupervisorState } from './state.js';
import { throwIfRequestAborted } from '../../../runtime/request-lease-identity.js';
import { CoralSetupError } from '../../../runtime/errors.js';
import type { KbDaemonWireTypes } from './index.js';
type KbDaemonExpansionRequest = KbDaemonWireTypes['expansionRequest'];
type KbDaemonExpansionResult = KbDaemonWireTypes['expansionResult'];
type KbDaemonKbMutationRequest = KbDaemonWireTypes['mutationRequest'];
type KbDaemonKbMutationResult = KbDaemonWireTypes['mutationResult'];
type KbDaemonKbReadRequest = KbDaemonWireTypes['readRequest'];
type KbDaemonKbReadResult = KbDaemonWireTypes['readResult'];
import type { createKbDaemonProbes } from './probes.js';
import type { createKbDaemonRpc } from './rpc.js';

type RequestRecoveryDependencies = Pick<ReturnType<typeof createKbDaemonProbes>, 'recoverForRequest'> &
  Pick<
    ReturnType<typeof createKbDaemonRpc>,
    'kbUnavailable' | 'sendKbReadRequest' | 'sendKbMutationRequest' | 'sendExpansionRpcRequest'
  >;

function createKbDaemonReadRecovery(state: KbDaemonSupervisorState, dependencies: RequestRecoveryDependencies) {
  const { kbUnavailable, sendKbReadRequest, recoverForRequest } = dependencies;
  const readKbNow = async (
    request: KbDaemonKbReadRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<KbDaemonKbReadResult> => {
    if (!state.requestRecoveryEnabled) {
      return kbUnavailable('KB daemon read request skipped: supervisor is disposing.');
    }
    if (options.signal?.aborted) {
      return kbUnavailable('KB daemon read request aborted.');
    }
    const failedGeneration = state.generation;
    const failedPhase = state.phase;
    try {
      return await sendKbReadRequest(request, options);
    } catch (error: unknown) {
      if (error instanceof CoralSetupError) {
        throw error;
      }
      if (options.signal?.aborted) {
        return kbUnavailable('KB daemon read request aborted.');
      }
      const initialError = errorMessage(error);
      const recovered = await recoverForRequest(failedGeneration, failedPhase, 'read request recovery');
      if (recovered.phase !== 'online') {
        return kbUnavailable(`KB daemon read request failed: ${initialError}; recovery ended in ${recovered.phase}.`);
      }
      try {
        return await sendKbReadRequest(request, options);
      } catch (retryError: unknown) {
        if (retryError instanceof CoralSetupError) {
          throw retryError;
        }
        if (options.signal?.aborted) {
          return kbUnavailable('KB daemon read request aborted.');
        }
        return kbUnavailable(
          `KB daemon read request failed after recovery: ${errorMessage(retryError)}; initial failure: ${initialError}`,
        );
      }
    }
  };

  return readKbNow;
}

function createKbDaemonMutationRecovery(state: KbDaemonSupervisorState, dependencies: RequestRecoveryDependencies) {
  const { kbUnavailable, sendKbMutationRequest, sendExpansionRpcRequest, recoverForRequest } = dependencies;
  const mutateKbNow = async (
    request: KbDaemonKbMutationRequest,
    signal?: AbortSignal,
  ): Promise<KbDaemonKbMutationResult> => {
    throwIfRequestAborted(signal);
    if (!state.requestRecoveryEnabled) {
      return kbUnavailable('KB daemon mutation request skipped: supervisor is disposing.');
    }
    const failedGeneration = state.generation;
    const failedPhase = state.phase;
    if (state.phase !== 'online' || state.daemonProcess === null) {
      const recovered = await recoverForRequest(failedGeneration, failedPhase, 'mutation request recovery');
      throwIfRequestAborted(signal);
      if (recovered.phase !== 'online') {
        return kbUnavailable(`KB daemon mutation request skipped: recovery ended in ${recovered.phase}.`);
      }
    }
    try {
      throwIfRequestAborted(signal);
      return await sendKbMutationRequest(request);
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      if (error instanceof CoralSetupError) {
        throw error;
      }
      return kbUnavailable(`KB daemon mutation request failed: ${errorMessage(error)}; request was not retried.`);
    }
  };

  const expansionRpcNow = async (
    request: KbDaemonExpansionRequest,
    signal?: AbortSignal,
  ): Promise<KbDaemonExpansionResult> => {
    throwIfRequestAborted(signal);
    if (!state.requestRecoveryEnabled) {
      return kbUnavailable('KB daemon expansion request skipped: supervisor is disposing.');
    }
    const failedGeneration = state.generation;
    const failedPhase = state.phase;
    if (state.phase !== 'online' || state.daemonProcess === null) {
      const recovered = await recoverForRequest(failedGeneration, failedPhase, 'expansion request recovery');
      throwIfRequestAborted(signal);
      if (recovered.phase !== 'online') {
        return kbUnavailable(`KB daemon expansion request skipped: recovery ended in ${recovered.phase}.`);
      }
    }
    try {
      throwIfRequestAborted(signal);
      return await sendExpansionRpcRequest(request);
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      if (error instanceof CoralSetupError) {
        throw error;
      }
      return kbUnavailable(`KB daemon expansion request failed: ${errorMessage(error)}; request was not retried.`);
    }
  };

  return { mutateKbNow, expansionRpcNow };
}

export function createKbDaemonRequestRecovery(
  state: KbDaemonSupervisorState,
  dependencies: RequestRecoveryDependencies,
) {
  const readKbNow = createKbDaemonReadRecovery(state, dependencies);
  const { mutateKbNow, expansionRpcNow } = createKbDaemonMutationRecovery(state, dependencies);
  return { readKbNow, mutateKbNow, expansionRpcNow };
}
