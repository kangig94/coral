import { readFileSync } from 'node:fs';

import {
  type ProviderAppServerContract,
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
} from './claude/adapter.js';
import { codexThreadProvider } from './codex/thread-provider.js';
import { codexAppServerLifecycle, codexPreflight } from './codex/adapter.js';
import { ProviderRegistry } from './registry.js';
import { createScriptedProvider, readScriptedProviderSpecFromEnv } from './scripted-provider.js';
import { toProviderSpec } from './spec-compat.js';

function adaptAppServerContract(
  name: string,
  subscriptionPhase: 'beforeInitialize' | 'afterInitialize',
  lifecycle: {
    buildServerSpec: NonNullable<NonNullable<typeof claudeAppServerLifecycle>['buildServerSpec']>;
    interrupt: NonNullable<NonNullable<typeof claudeAppServerLifecycle>['interrupt']>;
  },
): ProviderAppServerContract {
  return {
    name,
    subscriptionPhase,
    buildServerSpec: (request, persistedContinuity) => lifecycle.buildServerSpec(persistedContinuity, request),
    interrupt: (lease, continuity) => lifecycle.interrupt(lease, continuity),
  };
}

function buildClaudeRecovery(): ProviderRecoveryContract {
  return {
    probe: claudeAppServerLifecycle.probe.bind(claudeAppServerLifecycle),
    finalizeInterrupted: claudeAppServerLifecycle.finalizeInterrupted.bind(claudeAppServerLifecycle),
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
  };
}

function buildCodexRecovery(): ProviderRecoveryContract {
  return {
    probe: codexAppServerLifecycle.probe.bind(codexAppServerLifecycle),
    finalizeInterrupted: codexAppServerLifecycle.finalizeInterrupted.bind(codexAppServerLifecycle),
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
  appServer: adaptAppServerContract('codex', 'afterInitialize', codexAppServerLifecycle),
  recovery: buildCodexRecovery(),
};

const claudeProviderSpec: ProviderSpec = {
  name: 'claude',
  run: claudeProvider,
  preflight: claudePreflight,
  appServer: adaptAppServerContract('claude', 'beforeInitialize', claudeAppServerLifecycle),
  recovery: buildClaudeRecovery(),
  cleanup: claudeArtifactCleanup,
};

const BUILT_IN_PROVIDERS = [codexProviderSpec, claudeProviderSpec] as const;

function resolveBuiltInProviders(env: NodeJS.ProcessEnv = process.env): ProviderSpec[] {
  const scriptedProviderSpec = readScriptedProviderSpecFromEnv(env);
  if (scriptedProviderSpec === null) {
    return [...BUILT_IN_PROVIDERS];
  }

  const scriptedProvider = toProviderSpec(createScriptedProvider(scriptedProviderSpec));
  if (!scriptedProvider) {
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
