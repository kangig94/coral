import type { SessionContinuityContract } from '../middleware/session-continuity.js';
import { adapterParseGuard } from '../middleware/adapter-parse-guard.js';
import { appServerSession } from '../middleware/app-server-session.js';
import { sessionContinuity } from '../middleware/session-continuity.js';
import type { AppServerContract } from '../app-server/driver.js';
import {
  compose,
  type Provider,
  type ProviderContinuityBlob,
  type ProviderContinuityUpdate,
  type ProviderRuntime,
  type ProviderTerminalEventBody,
} from '../contract.js';
import { providerRequestFailed } from '../fault.js';
import { streamProviderTerminal } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { claudeExecKernel, isClaudeExecParseError } from './exec-kernel.js';
import {
  buildClaudeBootstrapSignature,
  buildClaudeProviderServerSpec,
  readClaudePersistedContinuity,
  withClaudeContinuity,
  type ClaudePersistedContinuity,
} from './request-mapping.js';
import { claudeSessionKernel, mapClaudeInterrupt } from './session-kernel.js';
import { buildPreparedClaudeRequest, sameBootstrapSignature } from './request-prep.js';

type ClaudeContinuityState = ClaudePersistedContinuity & {
  resumable: boolean;
};

const claudeAppServerContract = {
  name: 'claude',
  subscriptionPhase: 'beforeInitialize',
  buildServerSpec() {
    return buildClaudeProviderServerSpec();
  },
  interrupt: mapClaudeInterrupt,
} satisfies AppServerContract;

export const claudeExecContinuity = createClaudeContinuityContract(inferExecResumable, () => false);

export const claudeBrokerContinuity = createClaudeContinuityContract(
  inferBrokerResumable,
  isClaudeBrokerSessionUnavailable,
  (state) => {
    if (!state.brokerTurnId) {
      return state;
    }

    const { brokerTurnId: _brokerTurnId, ...continuity } = withClaudeContinuity(undefined, state);
    return {
      ...continuity,
      resumable: inferBrokerResumable(continuity),
    };
  },
);

export const claudeExecProvider = compose(
  sessionContinuity('claude', claudeExecContinuity),
  adapterParseGuard('claude', isClaudeExecParseError),
  claudeExecKernel,
);

export const claudeSessionProvider = compose(
  sessionContinuity('claude', claudeBrokerContinuity),
  appServerSession(claudeAppServerContract),
  claudeSessionKernel,
);

export const claudeDispatchTargets = {
  exec: claudeExecProvider,
  session: claudeSessionProvider,
};

export const claude: Provider = (request, runtime) => {
  const prepared = buildPreparedClaudeRequest(request);
  const persistedContinuity = readClaudePersistedContinuity(runtime.persistedContinuity);

  if (request.action === 'fork') {
    assertValidForkContinuity(persistedContinuity, runtime);

    if (persistedContinuity.brokerSessionKey || persistedContinuity.bootstrapSignature) {
      return streamProviderTerminal(
        buildDispatchRejectedTerminal(
          prepared.model,
          'This Claude session already established persistent continuity. Start a new Coral session before forking.',
        ),
      );
    }

    return claudeDispatchTargets.exec(request, runtime);
  }

  if (persistedContinuity.bootstrapSignature) {
    const actual = buildClaudeBootstrapSignature(request, prepared.systemPrompt);
    if (!sameBootstrapSignature(persistedContinuity.bootstrapSignature, actual)) {
      return streamProviderTerminal(
        buildDispatchRejectedTerminal(
          prepared.model,
          `This Claude session already established persistent continuity with cwd=${persistedContinuity.bootstrapSignature.cwd}, systemPromptHash=${persistedContinuity.bootstrapSignature.systemPromptHash}, permissionMode=${persistedContinuity.bootstrapSignature.permissionMode}. Start a new Coral session before changing that bootstrap signature.`,
        ),
      );
    }
  }

  return claudeDispatchTargets.session(request, runtime);
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

function inferExecResumable(continuity: ClaudePersistedContinuity): boolean {
  return Boolean(continuity.bootstrapSignature ?? continuity.conversationRef);
}

function inferBrokerResumable(continuity: ClaudePersistedContinuity): boolean {
  return Boolean(continuity.bootstrapSignature ?? continuity.brokerSessionKey ?? continuity.conversationRef);
}

function isClaudeBrokerSessionUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /session unavailable/i.test(message);
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

function assertValidForkContinuity(continuity: ClaudePersistedContinuity, runtime: ProviderRuntime): void {
  if (continuity.brokerSessionKey || continuity.bootstrapSignature) {
    return;
  }
  if (!continuity.envHash && !continuity.conversationRef && !continuity.brokerTurnId) {
    return;
  }
  if (runtime.env?.get('CORAL_DEV_ASSERTIONS') !== '1') {
    return;
  }

  const assertion = new Error(
    'Claude fork received envHash, conversationRef, or brokerTurnId without brokerSessionKey or bootstrapSignature.',
  );
  assertion.name = 'AssertionError';
  throw assertion;
}
