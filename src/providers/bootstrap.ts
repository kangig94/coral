import type { StoragePort } from '../runtime/ports.js';
import { type ProviderRecoveryContract, type ProviderSpec, type ProviderTerminalOutcome } from './contract.js';
import { buildJobDiagnostics, buildJobTerminal } from './terminal.js';
import { adapterOutputUnparseable } from './fault.js';
import { parseClaudeStreamJson } from './claude/output-parser.js';
import { claudeProvider } from './claude/exec-provider.js';
import {
  claudeAppServerLifecycle,
  claudeArtifactCleanup,
  claudePreflight,
  claudeRecoveryLifecycle,
} from './claude/provider-facets.js';
import { codexThreadProvider } from './codex/thread-provider.js';
import { codexAppServerLifecycle, codexPreflight, codexRecoveryLifecycle } from './codex/provider-facets.js';
import { ProviderRegistry } from './registry.js';

function buildProviderRecovery(
  lifecycle: Pick<ProviderRecoveryContract, 'probe' | 'finalizeInterrupted'>,
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
  };
}

async function finalizeClaudeFromArtifacts(
  options: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0],
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

  const outcome: ProviderTerminalOutcome =
    options.signal !== null
      ? { kind: 'aborted', reason: 'signal_abort' as const }
      : adapterUnparseable !== undefined
        ? { kind: 'failed' as const }
        : parsed.isError
          ? {
              kind: 'provider_exit' as const,
              code: options.exitCode ?? 1,
              ...(parsed.response ? { note: parsed.response } : { note: 'Claude request failed.' }),
            }
          : { kind: 'completed' as const };

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
    continuity:
      parsed.sessionId !== null
        ? {
            conversationRef: parsed.sessionId,
            resumable: true,
          }
        : options.fallbackConversationRef
          ? undefined
          : {
              conversationRef: null,
              resumable: false,
            },
  };
}

async function finalizeCodexFromArtifacts(
  options: Parameters<ProviderRecoveryContract['finalizeFromArtifacts']>[0],
): ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']> {
  const stdout = readArtifact(options.storage, options.stdoutPath);
  const stderr = readArtifact(options.storage, options.stderrPath);
  const outcome: ProviderTerminalOutcome =
    options.signal !== null
      ? { kind: 'aborted', reason: 'signal_abort' as const }
      : options.exitCode === null || options.exitCode === 0
        ? { kind: 'completed' as const }
        : {
            kind: 'provider_exit' as const,
            code: options.exitCode,
            note: `Codex exited with code ${options.exitCode} before recovery completed.`,
          };
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
  };
}

function readArtifact(storage: Pick<StoragePort, 'readFileSync'>, path: string): string {
  try {
    return storage.readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

const codexProviderSpec: ProviderSpec = {
  name: 'codex',
  run: codexThreadProvider,
  preflight: codexPreflight,
  appServer: codexAppServerLifecycle,
  recovery: buildProviderRecovery(codexRecoveryLifecycle, finalizeCodexFromArtifacts, 'Codex'),
};

const claudeProviderSpec: ProviderSpec = {
  name: 'claude',
  run: claudeProvider,
  preflight: claudePreflight,
  appServer: claudeAppServerLifecycle,
  recovery: buildProviderRecovery(claudeRecoveryLifecycle, finalizeClaudeFromArtifacts, 'Claude'),
  cleanup: claudeArtifactCleanup,
};

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
