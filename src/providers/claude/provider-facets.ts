import { join } from 'node:path';

import { discardRecordedArtifacts, managed } from '../capability.js';
import { detectClaudeCli } from '../cli-detection.js';
import type {
  PreflightRuntime,
  ProviderArtifactHandleInput,
  ProviderAppServerContract,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '../contract.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';
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

type ClaudeArtifactLocatorStorage = Pick<StoragePort, 'existsSync' | 'readdirSync'>;
type ClaudeArtifactLocatorEnv = Pick<Runtime['env'], 'homedir'>;

export type ClaudeArtifactLocatorResult =
  | { readonly kind: 'match'; readonly artifact: ProviderArtifactHandleInput }
  | { readonly kind: 'no_match'; readonly diagnostic: string }
  | { readonly kind: 'ambiguous'; readonly diagnostic: string; readonly matches: readonly string[] };

export function resolveClaudeProjectsRoot(env: ClaudeArtifactLocatorEnv): string {
  return join(env.homedir(), '.claude', 'projects');
}

export function locateClaudeJsonlArtifact(options: {
  readonly conversationRef: string;
  readonly projectsRoot: string;
  readonly storage: ClaudeArtifactLocatorStorage;
}): ClaudeArtifactLocatorResult {
  const matches = collectClaudeJsonlMatches(options.storage, options.projectsRoot, options.conversationRef);
  if (matches.length === 0) {
    return {
      kind: 'no_match',
      diagnostic: `No JSONL found matching conversation ${options.conversationRef} under ${options.projectsRoot}.`,
    };
  }
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      diagnostic: `${matches.length} JSONL files matched conversation ${options.conversationRef} under ${options.projectsRoot}; cannot choose one.`,
      matches,
    };
  }
  const [handle] = matches;
  return {
    kind: 'match',
    artifact: {
      handle,
    },
  };
}

export function locateClaudeJsonlArtifactFromRuntime(
  conversationRef: string,
  runtime: Pick<ProviderRuntime, 'env' | 'storage'>,
): ClaudeArtifactLocatorResult | null {
  if (!runtime.env) {
    return null;
  }
  return locateClaudeJsonlArtifact({
    conversationRef,
    projectsRoot: resolveClaudeProjectsRoot(runtime.env),
    storage: runtime.storage,
  });
}

function collectClaudeJsonlMatches(
  storage: ClaudeArtifactLocatorStorage,
  projectsRoot: string,
  conversationRef: string,
): readonly string[] {
  if (!safeExists(storage, projectsRoot)) {
    return [];
  }

  const target = `${conversationRef}.jsonl`;
  const matches: string[] = [];
  for (const projectEntry of safeReadDir(storage, projectsRoot)) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const projectDir = join(projectsRoot, projectEntry.name);
    for (const artifactEntry of safeReadDir(storage, projectDir)) {
      if (artifactEntry.isFile() && artifactEntry.name === target) {
        matches.push(join(projectDir, artifactEntry.name));
      }
    }
  }
  return matches.sort();
}

function safeExists(storage: ClaudeArtifactLocatorStorage, path: string): boolean {
  try {
    return storage.existsSync(path);
  } catch {
    return false;
  }
}

function safeReadDir(storage: ClaudeArtifactLocatorStorage, path: string) {
  try {
    return storage.readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export const claudeArtifactCapability = managed({
  discardArtifacts: discardRecordedArtifacts,
});

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
