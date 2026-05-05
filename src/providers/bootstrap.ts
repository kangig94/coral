import type { StoragePort } from '../infra/port-types.js';
import {
  type ProviderArtifactHandleInput,
  type ProviderRecoveryContract,
  type ProviderTerminalOutcome,
} from './contract.js';
import { buildJobDiagnostics, buildJobTerminal } from './terminal.js';
import { adapterOutputUnparseable } from './fault.js';
import { parseClaudeStreamJson } from './claude/output-parser.js';
import { claudeProvider } from './claude/exec-provider.js';
import {
  claudeAppServerLifecycle,
  claudeArtifactCapability,
  claudePreflight,
  claudeRecoveryLifecycle,
  locateClaudeJsonlArtifact,
  resolveClaudeProjectsRoot,
} from './claude/provider-facets.js';
import { codexThreadProvider } from './codex/thread-provider.js';
import {
  codexAppServerLifecycle,
  codexArtifactCapability,
  codexPreflight,
  codexRecoveryLifecycle,
  locateCodexRolloutArtifact,
  resolveCodexSessionsRoot,
} from './codex/provider-facets.js';
import { defineProvider } from './define.js';
import { ProviderRegistry } from './registry.js';

type ArtifactRecoveryOptions = Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0];
type ParsedClaudeArtifactOutput = ReturnType<typeof parseClaudeStreamJson>;

function buildProviderRecovery(
  lifecycle: Pick<ProviderRecoveryContract, 'probe' | 'finalizeInterrupted'> &
    Partial<Pick<ProviderRecoveryContract, 'buildRecoveryMeta' | 'extractProgress'>>,
  finalizeFromArtifacts: ProviderRecoveryContract['finalizeFromArtifacts'],
  providerName: string,
): ProviderRecoveryContract {
  const { probe, finalizeInterrupted } = lifecycle;
  if (!probe || !finalizeInterrupted) {
    throw new Error(`${providerName} recovery lifecycle must define probe + finalizeInterrupted`);
  }
  return {
    probe: probe.bind(lifecycle),
    finalizeInterrupted: finalizeInterrupted.bind(lifecycle),
    finalizeFromArtifacts,
    ...(lifecycle.buildRecoveryMeta ? { buildRecoveryMeta: lifecycle.buildRecoveryMeta.bind(lifecycle) } : {}),
    ...(lifecycle.extractProgress ? { extractProgress: lifecycle.extractProgress.bind(lifecycle) } : {}),
  };
}

async function finalizeClaudeFromArtifacts(
  options: ArtifactRecoveryOptions,
): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']> {
  const stdout = readArtifact(options.storage, options.stdoutPath);
  const stderr = readArtifact(options.storage, options.stderrPath);
  const parsed = parseClaudeStreamJson(stdout);

  if (parsed.isError && !parsed.response) {
    throw new Error('Claude recovery could not parse stream-json output.');
  }

  const exitedNonZero = options.exitCode !== null && options.exitCode !== 0;
  const adapterUnparseable =
    options.signal === null && exitedNonZero && !parsed.isError
      ? adapterOutputUnparseable({
          provider: 'claude',
          exitCode: options.exitCode,
          stdout,
          stderr,
          parseError: `Claude exited with code ${options.exitCode} before a valid result was recovered.`,
        })
      : undefined;

  const outcome = claudeArtifactOutcome(options, parsed, adapterUnparseable);

  return {
    terminal: {
      kind: 'terminal',
      terminal: buildJobTerminal({
        content: parsed.response,
        ...(parsed.model === null ? {} : { model: parsed.model }),
        ...(parsed.durationMs === null ? {} : { durationMs: parsed.durationMs }),
        ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
        usage: { costUsd: parsed.costUsd },
        outcome,
      }),
      diagnostics: buildJobDiagnostics({ stdout, stderr }),
      ...(adapterUnparseable === undefined ? {} : { failureCause: adapterUnparseable }),
    },
    continuity: claudeArtifactContinuity(options, parsed),
    artifactHandles: locateClaudeArtifactsForRecovery(options, parsed.sessionId),
  };
}

function claudeArtifactOutcome(
  options: ArtifactRecoveryOptions,
  parsed: ParsedClaudeArtifactOutput,
  adapterUnparseable: ReturnType<typeof adapterOutputUnparseable> | undefined,
): ProviderTerminalOutcome {
  if (options.signal !== null) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }

  if (adapterUnparseable !== undefined) {
    return { kind: 'failed' };
  }

  if (parsed.isError) {
    return {
      kind: 'provider_exit',
      code: options.exitCode ?? 1,
      ...(parsed.response ? { note: parsed.response } : { note: 'Claude request failed.' }),
    };
  }

  return { kind: 'completed' };
}

function claudeArtifactContinuity(
  options: ArtifactRecoveryOptions,
  parsed: ParsedClaudeArtifactOutput,
): Awaited<ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']>>['continuity'] {
  if (parsed.sessionId !== null) {
    return {
      conversationRef: parsed.sessionId,
      resumable: true,
    };
  }

  if (options.fallbackConversationRef) {
    return undefined;
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
    continuity: options.fallbackConversationRef
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
  parsedSessionId: string | null,
): readonly ProviderArtifactHandleInput[] | undefined {
  const conversationRef =
    parsedSessionId ?? readProviderMetaString(options.providerMeta, 'conversationRef', 'sessionId') ?? undefined;
  if (!conversationRef) {
    return undefined;
  }
  const result = locateClaudeJsonlArtifact({
    conversationRef,
    projectsRoot: resolveClaudeProjectsRoot(options.env),
    storage: options.storage,
  });
  return artifactHandlesFromLocator(result);
}

function locateCodexArtifactsForRecovery(
  options: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0],
): readonly ProviderArtifactHandleInput[] | undefined {
  const threadId =
    readProviderMetaString(options.providerMeta, 'threadId', 'conversationRef') ??
    readProviderContinuityString(options.providerMeta, 'threadId') ??
    options.fallbackConversationRef;
  if (!threadId) {
    return undefined;
  }
  const result = locateCodexRolloutArtifact({
    threadId,
    sessionsRoot: resolveCodexSessionsRoot(options.env),
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
  if (!providerMeta) {
    return undefined;
  }
  for (const key of keys) {
    const value = providerMeta[key];
    if (typeof value === 'string' && value.length > 0) {
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
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
  const providers = [...BUILT_IN_PROVIDERS];
  const existingProviders = providers.map((provider) => ({
    provider,
    existing: registry.get(provider.name),
  }));

  if (existingProviders.every(({ provider, existing }) => existing === provider)) {
    return;
  }

  const conflicts = existingProviders
    .filter(({ existing }) => existing !== undefined)
    .map(({ provider }) => provider.name);
  if (conflicts.length > 0) {
    throw new Error(
      `Built-in provider${conflicts.length === 1 ? '' : 's'} already registered: ${conflicts.join(', ')}`,
    );
  }

  for (const { provider } of existingProviders) {
    registry.register(provider);
  }
}

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry);
  return registry;
}
