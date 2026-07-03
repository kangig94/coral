import { type SessionContinuityContract, sessionContinuity } from '../middleware/session-continuity.js';
import { appServerSession } from '../middleware/app-server-session.js';
import type { AppServerContract } from '../app-server.js';
import { compose, type Provider, type ProviderContinuityUpdate } from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import {
  buildClaudeBootstrapSignature,
  buildClaudeProviderServerSpec,
  readClaudePersistedContinuity,
  withClaudeContinuity,
  type ClaudePersistedContinuity,
} from './request-mapping.js';
import { claudeSessionKernel, mapClaudeInterrupt } from './session-kernel.js';
import { buildPreparedClaudeRequest, sameBootstrapSignature } from './request-prep.js';
import { streamProviderTerminal } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { providerRequestFailed } from '../fault.js';
import { errorMessage } from '../../infra/error-format.js';
import type { ProviderTerminalEventBody } from '../contract.js';

type ClaudeContinuityState = ClaudePersistedContinuity & {
  resumable: boolean;
};

const claudeAppServerContract = {
  name: 'claude',
  subscriptionPhase: 'beforeInitialize',
  buildServerSpec(request, _persistedContinuity, ports) {
    return buildClaudeProviderServerSpec(request, ports.storage);
  },
  interrupt: mapClaudeInterrupt,
} satisfies AppServerContract;

export const claudeBrokerContinuity = createClaudeContinuityContract(
  inferBrokerResumable,
  isClaudeBrokerSessionUnavailable,
  (state) => {
    if (state.brokerTurnId === undefined) {
      return state;
    }

    const { brokerTurnId: _brokerTurnId, ...continuity } = withClaudeContinuity(undefined, state);
    return {
      ...continuity,
      resumable: inferBrokerResumable(continuity),
    };
  },
);

export const claudeSessionProvider = compose(
  sessionContinuity('claude', claudeBrokerContinuity),
  appServerSession(claudeAppServerContract),
  claudeSessionKernel,
);

export const claude: Provider = (request, runtime) => {
  const prepared = buildPreparedClaudeRequest(
    request,
    runtime.storage,
    runtime.kbRoot,
    runtime.coralProjects,
    runtime.projectSource,
    runtime.equippedTools,
  );
  const persistedContinuity = readClaudePersistedContinuity(runtime.persistedContinuity);

  if (persistedContinuity.bootstrapSignature) {
    const actual = buildClaudeBootstrapSignature(request, runtime.ids, prepared.systemPrompt);
    if (!sameBootstrapSignature(persistedContinuity.bootstrapSignature, actual)) {
      return streamProviderTerminal(
        buildDispatchRejectedTerminal(
          prepared.model,
          `This Claude session already established persistent continuity with cwd=${persistedContinuity.bootstrapSignature.cwd}, systemPromptHash=${persistedContinuity.bootstrapSignature.systemPromptHash}, permissionMode=${persistedContinuity.bootstrapSignature.permissionMode}. Start a new Coral session before changing that bootstrap signature.`,
        ),
      );
    }
  }

  return claudeSessionProvider(request, runtime);
};

export const claudeProvider = claude;

function createClaudeContinuityContract(
  inferResumable: (continuity: ClaudePersistedContinuity) => boolean,
  isSessionUnavailable: (error: unknown) => boolean,
  applyTransportClosed?: (state: ClaudeContinuityState) => ClaudeContinuityState,
): SessionContinuityContract<ClaudeContinuityState> {
  return {
    read(persisted) {
      const continuity = readClaudePersistedContinuity(persisted);
      const state = {
        ...continuity,
        resumable: inferResumable(continuity),
      };

      return {
        providerState: state,
        opening: snapshotClaudeContinuity(state),
      };
    },
    applyUpdate(state, update) {
      const continuity =
        update.providerContinuity === undefined
          ? applyConversationRefOverride(withClaudeContinuity(undefined, state), update.conversationRef)
          : readClaudePersistedContinuity(update.providerContinuity as ProviderContinuityBlob | undefined);

      return {
        ...continuity,
        resumable: update.resumable ?? inferResumable(continuity),
      };
    },
    snapshot: snapshotClaudeContinuity,
    ...(applyTransportClosed
      ? {
          applyTransportClosed(state) {
            return applyTransportClosed(state);
          },
        }
      : {}),
    isSessionUnavailable,
  };
}

function snapshotClaudeContinuity(state: ClaudeContinuityState) {
  return {
    conversationRef: state.conversationRef ?? null,
    resumable: state.resumable,
    providerContinuity: toProviderContinuityBlob(withClaudeContinuity(undefined, state)),
  };
}

function toProviderContinuityBlob(continuity: ClaudePersistedContinuity): ProviderContinuityBlob | null {
  return Object.keys(continuity).length === 0 ? null : continuity;
}

function applyConversationRefOverride(
  continuity: ClaudePersistedContinuity,
  conversationRef: ProviderContinuityUpdate['conversationRef'],
): ClaudePersistedContinuity {
  if (conversationRef === undefined) {
    return continuity;
  }

  if (conversationRef === null) {
    const { conversationRef: _conversationRef, ...rest } = continuity;
    return rest;
  }

  return {
    ...continuity,
    conversationRef,
  };
}

function inferBrokerResumable(continuity: ClaudePersistedContinuity): boolean {
  return (
    continuity.bootstrapSignature !== undefined ||
    continuity.brokerSessionKey !== undefined ||
    continuity.conversationRef !== undefined
  );
}

function isClaudeBrokerSessionUnavailable(error: unknown): boolean {
  return /session unavailable/i.test(errorMessage(error));
}

function buildDispatchRejectedTerminal(model: string | undefined, reason: string): ProviderTerminalEventBody {
  return {
    kind: 'terminal' as const,
    terminal: buildJobTerminal({
      content: '',
      model,
      outcome: { kind: 'failed' },
    }),
    diagnostics: buildJobDiagnostics({}),
    failureCause: providerRequestFailed({
      provider: 'claude',
      message: reason,
    }),
  };
}
