import { join } from 'node:path';
import type { StoragePort } from '../infra/port-types.js';
import { readString } from '../infra/json.js';
import {
  type ProviderArtifactHandleInput,
  type ProviderRecoveryContract,
  type ProviderTerminalOutcome,
} from './contract.js';
import { buildJobDiagnostics, buildJobTerminal } from './terminal.js';
import { claudeProvider } from './claude/provider.js';
import { claudeAppServerLifecycle, claudePreflight, claudeRecoveryLifecycle } from './claude/provider-facets.js';
import { claudeArtifactCapability, locateClaudeJsonlArtifact } from './claude/artifacts.js';
import { codexThreadProvider } from './codex/thread-provider.js';
import { codexAppServerLifecycle, codexPreflight, codexRecoveryLifecycle } from './codex/provider-facets.js';
import { codexArtifactCapability, locateCodexRolloutArtifact } from './codex/artifacts.js';
import { defineProvider } from './define.js';
import { ProviderRegistry } from './registry.js';

type ArtifactRecoveryOptions = Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0];

function buildProviderRecovery(
  lifecycle: Pick<ProviderRecoveryContract, 'finalizeInterrupted'> &
    Partial<Pick<ProviderRecoveryContract, 'probe' | 'buildRecoveryMeta' | 'extractProgress'>>,
  finalizeFromArtifacts: ProviderRecoveryContract['finalizeFromArtifacts'],
  providerName: string,
): ProviderRecoveryContract {
  const { finalizeInterrupted } = lifecycle;
  if (!finalizeInterrupted) {
    throw new Error(`${providerName} recovery lifecycle must define finalizeInterrupted`);
  }
  return {
    finalizeInterrupted: finalizeInterrupted.bind(lifecycle),
    finalizeFromArtifacts,
    ...(lifecycle.buildRecoveryMeta ? { buildRecoveryMeta: lifecycle.buildRecoveryMeta.bind(lifecycle) } : {}),
    ...(lifecycle.extractProgress ? { extractProgress: lifecycle.extractProgress.bind(lifecycle) } : {}),
    ...(lifecycle.probe ? { probe: lifecycle.probe.bind(lifecycle) } : {}),
  };
}

async function finalizeClaudeFromArtifacts(
  options: ArtifactRecoveryOptions,
): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']> {
  const stdout = readArtifact(options.storage, options.stdoutPath);
  const stderr = readArtifact(options.storage, options.stderrPath);
  const outcome = claudeArtifactOutcome(options);
  const artifactHandles = locateClaudeArtifactsForRecovery(options);

  return {
    terminal: {
      kind: 'terminal',
      terminal: buildJobTerminal({
        content: '',
        ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
        outcome,
      }),
      diagnostics: buildJobDiagnostics({ stdout, stderr }),
    },
    continuity: claudeArtifactContinuity(options, artifactHandles),
    artifactHandles,
  };
}

function claudeArtifactOutcome(options: ArtifactRecoveryOptions): ProviderTerminalOutcome {
  if (options.signal !== null) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }

  if (typeof options.exitCode === 'number' && options.exitCode !== 0) {
    return {
      kind: 'provider_exit',
      code: options.exitCode,
      note: `Claude exited with code ${options.exitCode} before recovery completed.`,
    };
  }

  return { kind: 'completed' };
}

function claudeArtifactContinuity(
  _options: ArtifactRecoveryOptions,
  artifactHandles: readonly ProviderArtifactHandleInput[] | undefined,
): Awaited<ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']>>['continuity'] {
  const conversationRef = artifactHandles
    ?.map((artifact) => readString(artifact.identity.conversationRef))
    .find((value) => value !== undefined);
  if (conversationRef !== undefined) {
    return {
      conversationRef,
      resumable: true,
    };
  }

  return {
    conversationRef: null,
    resumable: false,
  };
}

async function finalizeCodexFromArtifacts(
  options: ArtifactRecoveryOptions,
): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']> {
  const stdout = readArtifact(options.storage, options.stdoutPath);
  const stderr = readArtifact(options.storage, options.stderrPath);
  const outcome = codexArtifactOutcome(options);
  return {
    terminal: {
      kind: 'terminal',
      terminal: buildJobTerminal({
        content: '',
        ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
        outcome,
      }),
      diagnostics: buildJobDiagnostics({ stdout, stderr }),
    },
    continuity:
      readString(options.fallbackConversationRef) !== undefined
        ? undefined
        : {
            conversationRef: null,
            resumable: false,
          },
    artifactHandles: locateCodexArtifactsForRecovery(options),
  };
}

function codexArtifactOutcome(options: ArtifactRecoveryOptions): ProviderTerminalOutcome {
  if (options.signal !== null) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }

  if (options.exitCode === null || options.exitCode === 0) {
    return { kind: 'completed' };
  }

  return {
    kind: 'provider_exit',
    code: options.exitCode,
    note: `Codex exited with code ${options.exitCode} before recovery completed.`,
  };
}

function readArtifact(storage: Pick<StoragePort, 'readFileSync'>, path: string): string {
  try {
    return storage.readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function locateClaudeArtifactsForRecovery(
  options: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0],
): readonly ProviderArtifactHandleInput[] | undefined {
  const conversationRef =
    readProviderMetaString(options.providerMeta, 'conversationRef', 'sessionId') ??
    readProviderContinuityString(options.providerMeta, 'conversationRef') ??
    readString(options.fallbackConversationRef);
  if (conversationRef === undefined) {
    return undefined;
  }
  const knownMatches = options.knownArtifactHandles?.filter(
    (artifact) => readString(artifact.identity.conversationRef) === conversationRef,
  );
  if (knownMatches !== undefined && knownMatches.length > 0) {
    return knownMatches;
  }
  if (options.source.provider !== 'claude') return undefined;
  const result = locateClaudeJsonlArtifact({
    conversationRef,
    projectsRoot: options.source.projectsRoot,
    storage: options.storage,
  });
  return artifactHandlesFromLocator(result);
}

function locateCodexArtifactsForRecovery(
  options: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0],
): readonly ProviderArtifactHandleInput[] | undefined {
  if (options.knownArtifactHandles !== undefined && options.knownArtifactHandles.length > 0) {
    return options.knownArtifactHandles;
  }
  const threadId =
    readProviderMetaString(options.providerMeta, 'threadId', 'conversationRef') ??
    readProviderContinuityString(options.providerMeta, 'threadId') ??
    readString(options.fallbackConversationRef);
  if (threadId === undefined) {
    return undefined;
  }
  if (options.source.provider !== 'codex') return undefined;
  const result = locateCodexRolloutArtifact({
    threadId,
    sessionsRoot: join(options.source.home, 'sessions'),
    storage: options.storage,
  });
  return artifactHandlesFromLocator(result);
}

function artifactHandlesFromLocator(result: {
  readonly kind: string;
  readonly artifact?: ProviderArtifactHandleInput;
}): readonly ProviderArtifactHandleInput[] | undefined {
  return result.kind === 'match' && result.artifact ? [result.artifact] : undefined;
}

function readProviderMetaString(
  providerMeta: Record<string, unknown> | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (providerMeta === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const value = readString(providerMeta[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readProviderContinuityString(
  providerMeta: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const continuity = providerMeta?.providerContinuity;
  if (!continuity || typeof continuity !== 'object') {
    return undefined;
  }
  const value = (continuity as Record<string, unknown>)[key];
  return readString(value);
}

const codexProviderSpec = defineProvider({
  name: 'codex',
  run: codexThreadProvider,
  preflight: codexPreflight,
  appServer: codexAppServerLifecycle,
  recovery: buildProviderRecovery(codexRecoveryLifecycle, finalizeCodexFromArtifacts, 'Codex'),
})
  .artifacts(codexArtifactCapability)
  .build();

const claudeProviderSpec = defineProvider({
  name: 'claude',
  run: claudeProvider,
  preflight: claudePreflight,
  appServer: claudeAppServerLifecycle,
  recovery: buildProviderRecovery(claudeRecoveryLifecycle, finalizeClaudeFromArtifacts, 'Claude'),
})
  .artifacts(claudeArtifactCapability)
  .build();

const BUILT_IN_PROVIDERS = [codexProviderSpec, claudeProviderSpec] as const;

export function registerBuiltInProviders(registry: ProviderRegistry): void {
  let allRegistered = true;
  const conflicts: string[] = [];
  for (const provider of BUILT_IN_PROVIDERS) {
    const existing = registry.get(provider.name);
    if (existing !== provider) {
      allRegistered = false;
    }
    if (existing !== undefined) {
      conflicts.push(provider.name);
    }
  }

  if (allRegistered) {
    return;
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Built-in provider${conflicts.length === 1 ? '' : 's'} already registered: ${conflicts.join(', ')}`,
    );
  }

  for (const provider of BUILT_IN_PROVIDERS) {
    registry.register(provider);
  }
}

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry);
  return registry;
}
