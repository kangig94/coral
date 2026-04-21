import { appServerSession } from '../middleware/app-server-session.js';
import { sessionContinuity, type SessionContinuityContract } from '../middleware/session-continuity.js';
import { compose, type ProviderRequest } from '../contract.js';
import type { AppServerContract } from '../app-server/driver.js';
import {
  applyCodexContinuityUpdate,
  applyCodexTransportClosed,
  buildCodexProviderServerSpec,
  isCodexSessionUnavailable,
  readCodexPersistedContinuity,
  snapshotCodexPersistedContinuity,
  withCodexContinuity,
  type CodexPersistedContinuity,
} from './request-mapping.js';
import { codexTurnKernel, mapCodexInterrupt } from './thread-kernel.js';

function readOpeningContinuity(
  persistedContinuity: CodexPersistedContinuity | undefined,
  request: ProviderRequest,
): CodexPersistedContinuity {
  const continuity = readCodexPersistedContinuity(persistedContinuity);
  if (continuity.threadId || request.action !== 'resume' || !request.conversationRef) {
    return continuity;
  }

  return withCodexContinuity(continuity, {
    cwd: continuity.cwd ?? request.cwd,
    threadId: request.conversationRef,
  });
}

export const codexThreadContinuity: SessionContinuityContract<CodexPersistedContinuity> = {
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

const codexAppServerContract = {
  name: 'codex',
  buildServerSpec: buildCodexProviderServerSpec,
  interrupt: mapCodexInterrupt,
  subscriptionPhase: 'afterInitialize',
} satisfies AppServerContract;

export const codexThreadProvider = compose(
  sessionContinuity(codexThreadContinuity),
  appServerSession(codexAppServerContract, mapCodexInterrupt),
  codexTurnKernel,
);
