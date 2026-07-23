import { sessionContinuity, type SessionContinuityContract } from '../middleware/session-continuity.js';
import { compose, type ProviderAppServerRuntime, type ProviderRequest } from '../contract.js';
import { readString } from '../../infra/json.js';
import {
  applyCodexContinuityUpdate,
  applyCodexTransportClosed,
  isCodexSessionUnavailable,
  readCodexPersistedContinuity,
  snapshotCodexPersistedContinuity,
  withCodexContinuity,
  type CodexPersistedContinuity,
} from './request-mapping.js';
import { codexTurnKernel } from './thread-kernel.js';
import type { CodexExecutionPlan } from './execution-plan.js';

function readOpeningContinuity(
  persistedContinuity: CodexPersistedContinuity | undefined,
  request: ProviderRequest,
): CodexPersistedContinuity {
  const continuity = readCodexPersistedContinuity(persistedContinuity);
  const requestConversationRef = readString(request.conversationRef);
  if (continuity.threadId !== undefined || request.action !== 'resume' || requestConversationRef === undefined) {
    return continuity;
  }

  return withCodexContinuity(continuity, {
    cwd: continuity.cwd ?? request.cwd,
    threadId: requestConversationRef,
  });
}

const codexThreadContinuity: SessionContinuityContract<CodexPersistedContinuity> = {
  read(persistedContinuity, request) {
    const providerState = readOpeningContinuity(persistedContinuity, request);
    return {
      providerState,
      opening: snapshotCodexPersistedContinuity(providerState),
    };
  },
  applyUpdate: applyCodexContinuityUpdate,
  snapshot: snapshotCodexPersistedContinuity,
  applyTransportClosed: applyCodexTransportClosed,
  isSessionUnavailable: isCodexSessionUnavailable,
};

export const codexThreadProvider = compose(
  sessionContinuity<CodexPersistedContinuity, CodexExecutionPlan, ProviderAppServerRuntime<CodexExecutionPlan>>(
    'codex',
    codexThreadContinuity,
  ),
  codexTurnKernel,
);
