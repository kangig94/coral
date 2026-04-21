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
import { resolveScriptedProviderOverride } from './bootstrap-scripted-override.js';

function buildClaudeRecovery(
  lifecycle: Pick<ProviderRecoveryContract, 'probe' | 'finalizeInterrupted' | 'migrateLegacyContinuity'>,
): ProviderRecoveryContract {
  const { probe, finalizeInterrupted } = lifecycle;
  if (!probe || !finalizeInterrupted) {
    throw new Error('Claude recovery lifecycle must define probe + finalizeInterrupted');
  }
  return {
    probe: probe.bind(lifecycle),
    finalizeInterrupted: finalizeInterrupted.bind(lifecycle),
    async finalizeFromArtifacts(options) {
      const stdout = readArtifact(options.stdoutPath);
      const stderr = readArtifact(options.stderrPath);
      const parsed = parseClaudeStreamJson(stdout);

      if (parsed.isError && !parsed.response) {
        throw new Error('Claude recovery could not parse stream-json output.');
      }

      const outcome: TerminalOutcome =
        options.signal !== null
          ? { kind: 'aborted', reason: 'signal_abort' as const }
          : parsed.isError || (options.exitCode !== null && options.exitCode !== 0)
            ? {
                kind: 'failed' as const,
                fault: parsed.isError
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
                    }),
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
    },
    ...(lifecycle.migrateLegacyContinuity
      ? { migrateLegacyContinuity: lifecycle.migrateLegacyContinuity.bind(lifecycle) }
      : {}),
  };
}

function buildCodexRecovery(
  lifecycle: Pick<ProviderRecoveryContract, 'probe' | 'finalizeInterrupted' | 'migrateLegacyContinuity'>,
): ProviderRecoveryContract {
  const { probe, finalizeInterrupted } = lifecycle;
  if (!probe || !finalizeInterrupted) {
    throw new Error('Codex recovery lifecycle must define probe + finalizeInterrupted');
  }
  return {
    probe: probe.bind(lifecycle),
    finalizeInterrupted: finalizeInterrupted.bind(lifecycle),
    async finalizeFromArtifacts(options) {
      const stdout = readArtifact(options.stdoutPath);
      const stderr = readArtifact(options.stderrPath);
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
                  : {
                      kind: 'failed' as const,
                      fault: providerRequestFailed({
                        provider: 'codex',
                        message: `Codex exited with code ${options.exitCode} before recovery completed.`,
                      }),
                    },
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
    },
    ...(lifecycle.migrateLegacyContinuity
      ? { migrateLegacyContinuity: lifecycle.migrateLegacyContinuity.bind(lifecycle) }
      : {}),
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
  recovery: buildCodexRecovery(codexRecoveryLifecycle),
};

const claudeProviderSpec: ProviderSpec = {
  name: 'claude',
  run: claudeProvider,
  preflight: claudePreflight,
  appServer: claudeAppServerLifecycle,
  recovery: buildClaudeRecovery(claudeRecoveryLifecycle),
  cleanup: claudeArtifactCleanup,
};

const BUILT_IN_PROVIDERS = [codexProviderSpec, claudeProviderSpec] as const;

function resolveBuiltInProviders(env: NodeJS.ProcessEnv = process.env): ProviderSpec[] {
  const scriptedProvider = resolveScriptedProviderOverride(env);
  if (scriptedProvider === null) {
    return [...BUILT_IN_PROVIDERS];
  }

  const replacedProviders = BUILT_IN_PROVIDERS.map((provider) =>
    provider.name === scriptedProvider.name ? scriptedProvider : provider);
  if (replacedProviders.some((provider) => provider === scriptedProvider)) {
    return replacedProviders;
  }
  return [...replacedProviders, scriptedProvider];
}

export function registerBuiltInProviders(registry: ProviderRegistry, env: NodeJS.ProcessEnv = process.env): void {
  const providers = resolveBuiltInProviders(env);
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

export function createBuiltInProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry, env);
  return registry;
}
