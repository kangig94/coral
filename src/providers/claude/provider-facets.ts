import { join } from 'node:path';

import { detectClaudeCli } from '../cli-detection.js';
import type {
  ArtifactCleanupRuntime,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderServerLease,
} from '../contract.js';
import type { SessionProbeResult } from '../claude-appserver/protocol.js';
import {
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  mapInterruptParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
} from './request-mapping.js';
import { readString } from './shared-utils.js';

async function brokerRpc<R = unknown>(
  lease: ProviderServerLease,
  method: string,
  params: Record<string, unknown> | object,
): Promise<R> {
  return lease.rpc<R>(method, params as unknown as Record<string, unknown>);
}

export async function claudePreflight(): Promise<void> {
  const cli = await detectClaudeCli();
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
  buildServerSpec() {
    return buildClaudeProviderServerSpec();
  },
  async interrupt(lease, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    if (!persistedContinuity.brokerSessionKey) {
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
  async probe(lease, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    if (!persistedContinuity.brokerSessionKey) {
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
      result.status === 'available' || (result.status === 'missing' && Boolean(persistedContinuity.conversationRef));

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
          ...(persistedContinuity.brokerSessionKey ? { brokerSessionKey: persistedContinuity.brokerSessionKey } : {}),
          bootstrapSignature: persistedContinuity.bootstrapSignature,
          ...(persistedContinuity.envHash ? { envHash: persistedContinuity.envHash } : {}),
          ...(persistedContinuity.conversationRef ? { conversationRef: persistedContinuity.conversationRef } : {}),
        })
      : undefined;
    const effectiveConversationRef = persistedContinuity.conversationRef ?? context.preservedConversationRef;

    if (probeResult.resumable) {
      if (effectiveConversationRef) {
        return {
          type: 'set_resumable',
          conversationRef: effectiveConversationRef,
          ...(providerContinuity ? { providerContinuity } : {}),
        };
      }

      return {
        type: 'preserve',
        ...(providerContinuity ? { providerContinuity } : {}),
      };
    }

    return {
      type: 'clear_non_resumable',
      ...(providerContinuity ? { providerContinuity } : {}),
    };
  },
} satisfies Pick<ProviderRecoveryContract, 'probe' | 'finalizeInterrupted'>;

async function cleanupSessions(
  runtime: ArtifactCleanupRuntime,
  conversationRefs: readonly string[],
): Promise<void> {
  if (conversationRefs.length === 0) {
    return;
  }

  const projectsDir = join(runtime.env.homedir(), '.claude', 'projects');
  if (!runtime.storage.existsSync(projectsDir)) {
    return;
  }

  const targets = new Set(conversationRefs.map((id) => `${id}.jsonl`));
  const dirs = runtime.storage.readdirSync(projectsDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) {
      continue;
    }

    const dirPath = join(projectsDir, dir.name);
    const entries = runtime.storage.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !targets.has(entry.name)) {
        continue;
      }

      try {
        runtime.storage.unlinkSync(join(dirPath, entry.name));
      } catch {
        /* best-effort */
      }
    }
  }
}

export const claudeArtifactCleanup = {
  name: 'claude',
  cleanupSessions,
} as const;

function readTurnConversationRef(value: unknown): string | undefined {
  return readString((value as { conversationRef?: unknown; sessionId?: unknown }).conversationRef)
    ?? readString((value as { conversationRef?: unknown; sessionId?: unknown }).sessionId);
}
