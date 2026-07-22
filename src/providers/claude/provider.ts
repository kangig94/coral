import { type SessionContinuityContract, sessionContinuity } from '../middleware/session-continuity.js';
import {
  compose,
  type ProviderAppServer,
  type ProviderAppServerRuntime,
  type ProviderContinuityUpdate,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import {
  buildClaudeBootstrapSignature,
  readClaudePersistedContinuity,
  type ClaudePersistedContinuity,
} from './request-mapping.js';
import { claudeSessionKernel } from './session-kernel.js';
import { buildPreparedClaudeRequest, sameBootstrapSignature } from './request-prep.js';
import { streamProviderTerminal } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { providerRequestFailed } from '../fault.js';
import { errorMessage } from '../../infra/error-format.js';
import type { ProviderTerminalEventBody } from '../contract.js';
import type { ClaudeExecutionPlan } from './execution-plan.js';

type ClaudeContinuityState = ClaudePersistedContinuity & {
  resumable: boolean;
  conversationRef?: string;
};

const claudeBrokerContinuity = createClaudeContinuityContract(inferBrokerResumable, isClaudeBrokerSessionUnavailable);

const claudeSessionProvider = compose(
  sessionContinuity<ClaudeContinuityState, ClaudeExecutionPlan, ProviderAppServerRuntime<ClaudeExecutionPlan>>(
    'claude',
    claudeBrokerContinuity,
  ),
  claudeSessionKernel,
);

const claude: ProviderAppServer<ClaudeExecutionPlan> = (request, runtime) => {
  const startedAt = runtime.time.now();
  const prepared = buildPreparedClaudeRequest(request);
  const persistedContinuity = readClaudePersistedContinuity(runtime.persistedContinuity);

  if (persistedContinuity.bootstrapSignature) {
    const actual = buildClaudeBootstrapSignature(request, runtime.ids, {
      derivedSystemPrompt: prepared.systemPrompt,
      conversationRef: request.conversationRef ?? (request.action === 'exec' ? request.sessionId : undefined),
      resumeExisting: request.action === 'resume',
      projectsRoot: runtime.executionPlan.session.projectsRoot,
      model: prepared.model,
      effort: prepared.effort,
    });
    if (!sameBootstrapSignature(persistedContinuity.bootstrapSignature, actual)) {
      return streamProviderTerminal(
        buildDispatchRejectedTerminal(
          prepared.model,
          `This Claude session already established persistent continuity with cwd=${persistedContinuity.bootstrapSignature.cwd}, systemPromptHash=${persistedContinuity.bootstrapSignature.systemPromptHash}, permissionMode=${persistedContinuity.bootstrapSignature.permissionMode}. Start a new Coral session before changing that bootstrap signature.`,
          Math.max(0, runtime.time.now() - startedAt),
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
          ? applyConversationRefOverride(state, update.conversationRef)
          : {
              ...readClaudePersistedContinuity(update.providerContinuity as ProviderContinuityBlob | undefined),
              ...(update.conversationRef === undefined
                ? state.conversationRef === undefined
                  ? {}
                  : { conversationRef: state.conversationRef }
                : update.conversationRef === null
                  ? {}
                  : { conversationRef: update.conversationRef }),
            };

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
    providerContinuity: toProviderContinuityBlob(readClaudePersistedContinuity(state)),
  };
}

function toProviderContinuityBlob(continuity: ClaudePersistedContinuity): ProviderContinuityBlob | null {
  return Object.keys(continuity).length === 0 ? null : continuity;
}

function applyConversationRefOverride(
  continuity: ClaudeContinuityState,
  conversationRef: ProviderContinuityUpdate['conversationRef'],
): ClaudeContinuityState {
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
  return continuity.bootstrapSignature !== undefined;
}

function isClaudeBrokerSessionUnavailable(error: unknown): boolean {
  return /session unavailable/i.test(errorMessage(error));
}

function buildDispatchRejectedTerminal(
  model: string | undefined,
  reason: string,
  durationMs: number,
): ProviderTerminalEventBody {
  return {
    kind: 'terminal' as const,
    terminal: buildJobTerminal({
      content: '',
      model,
      durationMs,
      outcome: { kind: 'failed' },
    }),
    diagnostics: buildJobDiagnostics({}),
    failureCause: providerRequestFailed({
      provider: 'claude',
      message: reason,
    }),
  };
}
