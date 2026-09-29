import { rehydrateCoralSetupError } from '../../../runtime/errors.js';
import type { KbDaemonProtocolBindings, KbDaemonWireTypes } from '../kb-daemon-supervisor.js';
type KbDaemonAbortResult = KbDaemonWireTypes['abortResult'];
type KbDaemonExpansionRequest = KbDaemonWireTypes['expansionRequest'];
type KbDaemonExpansionResult = KbDaemonWireTypes['expansionResult'];
type KbDaemonJobsResult = KbDaemonWireTypes['jobsResult'];
type KbDaemonKbMutationRequest = KbDaemonWireTypes['mutationRequest'];
type KbDaemonKbMutationResult = KbDaemonWireTypes['mutationResult'];
type KbDaemonKbReadRequest = KbDaemonWireTypes['readRequest'];
type KbDaemonKbReadResult = KbDaemonWireTypes['readResult'];
type KbDaemonRequestMethod = KbDaemonWireTypes['requestMethod'];
import type { createKbDaemonRequests } from './requests.js';

export function createKbDaemonRpc(
  sendRequest: ReturnType<typeof createKbDaemonRequests>['sendRequest'],
  requestTimeoutMs: number,
  jobRequestTimeoutMs: number,
  protocol: KbDaemonProtocolBindings,
) {
  const {
    isKbDaemonAbortResult,
    isKbDaemonExpansionResult,
    isKbDaemonJobsResult,
    isKbDaemonKbMutationResult,
    isKbDaemonKbReadResult,
  } = protocol;
  const kbUnavailable = (message: string): KbDaemonKbReadResult => ({
    ok: false,
    code: 'kb_unavailable',
    message,
    detail: { reason: 'kb_daemon_unavailable' },
  });

  const sendTypedRequest = async (
    method: KbDaemonRequestMethod,
    request: unknown,
    isResult: (value: unknown) => value is KbDaemonKbReadResult,
    malformedMessage: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<KbDaemonKbReadResult> => {
    const response = await sendRequest(method, request, timeoutMs, signal);
    if (!response.ok) {
      const setupError = rehydrateCoralSetupError(response.error.setupError);
      if (setupError !== null) {
        throw setupError;
      }
      return { ok: false, code: 'kb_daemon_protocol_error', message: response.error.message };
    }
    if (!isResult(response.result)) {
      return { ok: false, code: 'kb_daemon_protocol_error', message: malformedMessage };
    }
    const setupError = response.result.ok ? null : rehydrateCoralSetupError(response.result.setupError);
    if (setupError !== null) {
      throw setupError;
    }
    return response.result;
  };

  const sendKbReadRequest = (
    request: KbDaemonKbReadRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<KbDaemonKbReadResult> =>
    // The JSONL daemon protocol has no per-request cancel frame yet. The signal
    // still cancels the parent-side wait promptly; daemon-side search
    // cancellation needs a protocol-level follow-up.
    sendTypedRequest(
      'kb.read',
      request,
      isKbDaemonKbReadResult,
      'KB daemon returned malformed read result.',
      undefined,
      options.signal,
    );

  const sendKbMutationRequest = (request: KbDaemonKbMutationRequest): Promise<KbDaemonKbMutationResult> => {
    const timeoutMs =
      request.method === 'createSource' || request.method === 'reindex' ? jobRequestTimeoutMs : undefined;
    return sendTypedRequest(
      'kb.mutate',
      request,
      isKbDaemonKbMutationResult,
      'KB daemon returned malformed mutation result.',
      timeoutMs,
    );
  };

  const sendExpansionRpcRequest = (request: KbDaemonExpansionRequest): Promise<KbDaemonExpansionResult> =>
    sendTypedRequest(
      'expansion.rpc',
      request,
      isKbDaemonExpansionResult,
      'KB daemon returned malformed expansion result.',
    );

  const abortKbJobsNow = async (jobIds: string[]): Promise<KbDaemonAbortResult> => {
    try {
      const response = await sendRequest('kb.abort', { jobIds });
      if (!response.ok || !isKbDaemonAbortResult(response.result)) {
        return { aborted: [], notFound: [...jobIds] };
      }
      return response.result;
    } catch {
      return { aborted: [], notFound: [...jobIds] };
    }
  };

  const listActiveKbJobsNow = async (options: { signal?: AbortSignal } = {}): Promise<KbDaemonJobsResult> => {
    try {
      const response = await sendRequest('kb.jobs', undefined, requestTimeoutMs, options.signal);
      if (!response.ok || !isKbDaemonJobsResult(response.result)) {
        return { active: [] };
      }
      return response.result;
    } catch {
      return { active: [] };
    }
  };

  const listActiveKbJobsForSuccession = async (options: { signal?: AbortSignal } = {}): Promise<KbDaemonJobsResult> => {
    const response = await sendRequest('kb.jobs', undefined, requestTimeoutMs, options.signal);
    if (!response.ok || !isKbDaemonJobsResult(response.result)) {
      throw new Error('KB daemon work inventory is unavailable.');
    }
    return response.result;
  };

  return {
    kbUnavailable,
    sendKbReadRequest,
    sendKbMutationRequest,
    sendExpansionRpcRequest,
    abortKbJobsNow,
    listActiveKbJobsNow,
    listActiveKbJobsForSuccession,
  };
}
