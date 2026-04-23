import { readFileSync } from 'node:fs';

import {
  type ProviderRecoveryContract,
  type ProviderSpec,
  type TerminalOutcome,
} from './contract.js';
import { buildJobDiagnostics, buildJobTerminal } from './terminal.js';
import { adapterOutputUnparseable, providerRequestFailed } from './fault.js';
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
  const stdout = readArtifact(options.stdoutPath);
  const stderr = readArtifact(options.stderrPath);
  const parsed = parseClaudeStreamJson(stdout);

  if (parsed.isError && !parsed.response) {
    throw new Error('Claude recovery could not parse stream-json output.');
  }

  const failureCause =
    options.signal !== null || (!parsed.isError && (options.exitCode === null || options.exitCode === 0))
      ? undefined
      : parsed.isError
        ? providerRequestFailed({
            provider: 'claude',
            message: parsed.response || 'Claude request failed.',
          })
        : adapterOutputUnparseable({
            provider: 'claude',
            exitCode: options.exitCode,
            stdout,
            stderr,
            parseError: `Claude exited with code ${options.exitCode} before a valid result was recovered.`,
          });
  const outcome: TerminalOutcome =
    options.signal !== null
      ? { kind: 'aborted', reason: 'signal_abort' as const }
      : parsed.isError || (options.exitCode !== null && options.exitCode !== 0)
        ? { kind: 'failed' as const }
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
      ...(failureCause === undefined ? {} : { failureCause }),
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
  const stdout = readArtifact(options.stdoutPath);
  const stderr = readArtifact(options.stderrPath);
  const failureCause =
    options.signal === null && options.exitCode !== null && options.exitCode !== 0
      ? providerRequestFailed({
          provider: 'codex',
          message: `Codex exited with code ${options.exitCode} before recovery completed.`,
        })
      : undefined;
  return {
    terminal: {
      kind: 'terminal',
      terminal: buildJobTerminal({
        content: '',
        ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
        outcome:
          options.signal !== null
            ? { kind: 'aborted', reason: 'signal_abort' as const }
            : options.exitCode === null || options.exitCode === 0
              ? { kind: 'completed' as const }
              : { kind: 'failed' as const },
      }),
      diagnostics: buildJobDiagnostics({ stdout, stderr }),
      ...(failureCause === undefined ? {} : { failureCause }),
    },
    continuity: options.fallbackConversationRef
      ? undefined
      : {
          conversationRef: null,
          resumable: false,
        },
  };
}

function readArtifact(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
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
