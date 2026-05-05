import { detectClaudeCli } from '../cli-detection.js';
import type {
  PreflightRuntime,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderServerLease,
} from '../contract.js';
import { readString } from '../../infra/json.js';
import type { SessionProbeResult } from '../claude-appserver/protocol.js';
import {
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  mapInterruptParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
} from './request-mapping.js';
import { readTurnConversationRef } from './request-prep.js';

async function brokerRpc<R = unknown>(
  lease: ProviderServerLease,
  method: string,
  params: Record<string, unknown> | object,
): Promise<R> {
  return lease.rpc<R>(method, params as unknown as Record<string, unknown>);
}

export async function claudePreflight(runtime: PreflightRuntime): Promise<void> {
  const cli = await detectClaudeCli(runtime.process, runtime.env);
  if (!cli.available) {
    throw new Error(`Claude CLI not available: ${cli.error}`);
  }
  if (cli.authState === 'unauthenticated') {
    throw new Error(`Claude CLI unauthenticated: ${cli.authError}`);
  }
}

export const claudeAppServerLifecycle: ProviderAppServerContract = {
  name: 'claude',
  subscriptionPhase: 'beforeInitialize',
  buildServerSpec(request, _persistedContinuity, ports) {
    return buildClaudeProviderServerSpec(request, ports.storage);
  },
  async interrupt(lease, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    if (persistedContinuity.brokerSessionKey === undefined) {
      throw new Error('Claude broker session key missing from continuity.');
    }

    await brokerRpc(
      lease,
      'turn/interrupt',
      mapInterruptParams(persistedContinuity.brokerSessionKey, persistedContinuity.brokerTurnId),
    );
  },
};

export const claudeRecoveryLifecycle = {
  buildRecoveryMeta(request: ProviderRequest) {
    const conversationRef = readString(request.conversationRef);
    return conversationRef !== undefined ? { conversationRef } : {};
  },
  async probe(lease, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    if (persistedContinuity.brokerSessionKey === undefined) {
      throw new Error('Claude broker session key missing from continuity.');
    }

    const result = await lease.rpc<SessionProbeResult>('session/probe', {
      brokerSessionKey: persistedContinuity.brokerSessionKey,
      conversationRef: persistedContinuity.conversationRef,
    });
    if (result.status === 'unavailable') {
      throw new Error('Claude broker session is unavailable.');
    }

    const updatedConversationRef = readTurnConversationRef(result) ?? persistedContinuity.conversationRef;
    const resumable =
      result.status === 'available' ||
      (result.status === 'missing' && persistedContinuity.conversationRef !== undefined);

    return {
      resumable,
      updatedContinuity: withClaudeContinuity(continuity, {
        brokerSessionKey: result.brokerSessionKey ?? persistedContinuity.brokerSessionKey,
        bootstrapSignature: result.bootstrapSignature ?? persistedContinuity.bootstrapSignature,
        envHash: persistedContinuity.envHash,
        conversationRef: updatedConversationRef,
      }),
    };
  },
  finalizeInterrupted(probeResult, continuity, context) {
    const persistedContinuity = readClaudePersistedContinuity(probeResult.updatedContinuity ?? continuity);
    const providerContinuity = persistedContinuity.bootstrapSignature
      ? buildClaudeContinuity({
          ...(persistedContinuity.brokerSessionKey !== undefined
            ? { brokerSessionKey: persistedContinuity.brokerSessionKey }
            : {}),
          bootstrapSignature: persistedContinuity.bootstrapSignature,
          ...(persistedContinuity.envHash !== undefined ? { envHash: persistedContinuity.envHash } : {}),
          ...(persistedContinuity.conversationRef !== undefined
            ? { conversationRef: persistedContinuity.conversationRef }
            : {}),
        })
      : undefined;
    const effectiveConversationRef = persistedContinuity.conversationRef ?? context.preservedConversationRef;

    if (probeResult.resumable) {
      if (effectiveConversationRef !== undefined) {
        return {
          kind: 'set_resumable',
          conversationRef: effectiveConversationRef,
          ...(providerContinuity ? { providerContinuity } : {}),
        };
      }

      return {
        kind: 'preserve',
        ...(providerContinuity ? { providerContinuity } : {}),
      };
    }

    return {
      kind: 'clear_non_resumable',
      ...(providerContinuity ? { providerContinuity } : {}),
    };
  },
} satisfies Pick<ProviderRecoveryContract, 'buildRecoveryMeta' | 'probe' | 'finalizeInterrupted'>;
