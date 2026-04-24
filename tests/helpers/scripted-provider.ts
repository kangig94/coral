import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod';

import type { SessionContinuityMutation } from '#src/sessions/continuity-mutation.js';
import type {
  PreflightRuntime,
  ProviderAppServerContract,
  ProviderArtifactCleanup,
  ProviderContinuityBlob,
  ProviderEventBody,
  ProviderRecoveryContract,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
  ProviderSpec,
  ProviderTerminalEventBody,
} from '#src/providers/contract.js';
import { terminalOutcomeSchema, usageSummarySchema } from '#src/providers/contract.js';
import { streamProviderEvents } from '#src/providers/stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '#src/providers/terminal.js';

export type { ArtifactCleanupRuntime, PreflightRuntime } from '#src/providers/contract.js';

const scriptedProviderProgressSchema = z
  .object({
    delayMs: z.number().int().nonnegative().optional(),
    message: z.string(),
    ts: z.string().optional(),
  })
  .strict();

const scriptedProviderResultSchema = z
  .object({
    content: z.string().optional(),
    conversationRef: z.string().optional(),
    model: z.string().optional(),
    durationMs: z.number().optional(),
    resumable: z.boolean().optional(),
    exitCode: z.number().nullable().optional(),
    warnings: z.array(z.string()).optional(),
    usage: usageSummarySchema.optional(),
    outcome: terminalOutcomeSchema.optional(),
  })
  .strict();

export const scriptedProviderSpecSchema = z
  .object({
    name: z.string().min(1),
    progress: z.array(scriptedProviderProgressSchema).optional(),
    result: scriptedProviderResultSchema.optional(),
    preflightError: z.string().optional(),
  })
  .strict();

export type ScriptedProviderSpec = z.infer<typeof scriptedProviderSpecSchema>;

function resolveConversationRef(
  request: ProviderRequest,
  spec: ScriptedProviderSpec,
): string {
  return spec.result?.conversationRef ?? request.conversationRef ?? `scripted-${request.sessionId}`;
}

export function createScriptedProvider(spec: ScriptedProviderSpec): ProviderSpec {
  const parsed = scriptedProviderSpecSchema.parse(spec);

  return {
    name: parsed.name,
    run(request, runtime) {
      const progress = parsed.progress ?? [];
      const conversationRef = resolveConversationRef(request, parsed);

      return streamProviderEvents(async (emit) => {
        for (const entry of progress) {
          if ((entry.delayMs ?? 0) > 0) {
            await delay(entry.delayMs, undefined, { signal: runtime.signal }).catch(() => undefined);
          }
          emit({
            kind: 'progress',
            message: entry.message,
          });
        }

        emit({
          kind: 'continuity',
          conversationRef,
          resumable: parsed.result?.resumable ?? true,
          providerContinuity: null,
        });
        emit({
          kind: 'terminal',
          terminal: buildJobTerminal({
            content: parsed.result?.content ?? '',
            outcome: parsed.result?.outcome ?? { kind: 'completed' },
            ...(parsed.result?.model === undefined ? {} : { model: parsed.result.model }),
            ...(parsed.result?.durationMs === undefined ? {} : { durationMs: parsed.result.durationMs }),
            ...(parsed.result?.exitCode === undefined ? {} : { exitCode: parsed.result.exitCode }),
            ...(parsed.result?.warnings === undefined ? {} : { warnings: [...parsed.result.warnings] }),
            ...(parsed.result?.usage === undefined ? {} : { usage: { ...parsed.result.usage } }),
          }),
          diagnostics: buildJobDiagnostics({}),
        });
      });
    },
    ...(parsed.preflightError
      ? {
          async preflight(_runtime: PreflightRuntime): Promise<void> {
            throw new Error(parsed.preflightError);
          },
        }
      : {}),
  };
}

type TestProviderInvocation = (
  request: ProviderRequest,
  runtime: ProviderRuntime,
) => AsyncIterable<ProviderEventBody>;

type TestAppServerLifecycle = {
  buildServerSpec(
    persistedContinuity: ProviderContinuityBlob | undefined,
    request: ProviderRequest,
  ): ProviderServerSpec;
  interrupt(lease: ProviderServerLease, continuity: ProviderContinuityBlob): Promise<void>;
  probe?(
    lease: ProviderServerLease,
    continuity: ProviderContinuityBlob,
  ): Promise<{ resumable: boolean; updatedContinuity?: ProviderContinuityBlob }>;
  finalizeInterrupted?(
    probeResult: { resumable: boolean; updatedContinuity?: ProviderContinuityBlob },
    continuity: ProviderContinuityBlob,
    context: { preservedConversationRef?: string },
  ): SessionContinuityMutation;
};

type TestArtifactRecovery = {
  finalizeFromArtifacts(options: {
    stdoutPath: string;
    stderrPath: string;
    exitCode: number | null;
    signal: string | null;
    providerMeta?: Record<string, unknown>;
    fallbackConversationRef?: string;
  }): Promise<
    | ProviderTerminalEventBody
    | {
        terminal: ProviderTerminalEventBody;
        continuity?: {
          conversationRef: string | null;
          resumable: boolean;
          providerContinuity?: ProviderContinuityBlob;
        };
      }
  >;
  buildRecoveryMeta?(request: ProviderRequest): Record<string, unknown>;
  extractProgress?(options: { stdoutPath: string; fromOffset: number; providerMeta?: Record<string, unknown> }): {
    messages: string[];
    newOffset: number;
  };
};

export type Provider = {
  readonly name: string;
  execute: TestProviderInvocation;
  preflight?(runtime: PreflightRuntime): Promise<void>;
  appServerLifecycle?: TestAppServerLifecycle;
  artifactRecovery?: TestArtifactRecovery;
  artifactCleanup?: ProviderArtifactCleanup;
};

function inferSubscriptionPhase(name: string): ProviderAppServerContract['subscriptionPhase'] {
  return name === 'claude' ? 'beforeInitialize' : 'afterInitialize';
}

function normalizeRecoveryResult(
  result: Awaited<ReturnType<NonNullable<TestArtifactRecovery['finalizeFromArtifacts']>>>,
): Awaited<ReturnType<ProviderRecoveryContract['finalizeFromArtifacts']>> {
  if ('kind' in result) {
    return { terminal: result };
  }

  return result;
}

export function toProviderSpec(provider: Provider | ProviderSpec | undefined): ProviderSpec | undefined {
  if (!provider) {
    return undefined;
  }

  if ('run' in provider) {
    return provider;
  }

  const appServerLifecycle = provider.appServerLifecycle;
  const appServer = appServerLifecycle
    ? {
        name: provider.name,
        subscriptionPhase: inferSubscriptionPhase(provider.name),
        buildServerSpec: (
          request: ProviderRequest,
          persistedContinuity: ProviderContinuityBlob | undefined,
        ) =>
          appServerLifecycle.buildServerSpec(persistedContinuity, request),
        interrupt: appServerLifecycle.interrupt,
      }
    : undefined;

  const recovery =
    provider.artifactRecovery || provider.appServerLifecycle
      ? {
          ...(provider.appServerLifecycle?.probe ? { probe: provider.appServerLifecycle.probe } : {}),
          ...(provider.appServerLifecycle?.finalizeInterrupted
            ? { finalizeInterrupted: provider.appServerLifecycle.finalizeInterrupted }
            : {}),
          finalizeFromArtifacts: (() => {
            const artifactRecovery = provider.artifactRecovery;
            return artifactRecovery
              ? async (
                  options: Parameters<NonNullable<TestArtifactRecovery['finalizeFromArtifacts']>>[0],
                ) => normalizeRecoveryResult(await artifactRecovery.finalizeFromArtifacts(options))
              : async () => {
                  throw new Error(`Provider ${provider.name} does not support artifact recovery.`);
                };
          })(),
          ...(provider.artifactRecovery?.buildRecoveryMeta
            ? { buildRecoveryMeta: provider.artifactRecovery.buildRecoveryMeta }
            : {}),
          ...(provider.artifactRecovery?.extractProgress
            ? { extractProgress: provider.artifactRecovery.extractProgress }
            : {}),
        }
      : undefined;

  return {
    name: provider.name,
    run: provider.execute,
    ...(provider.preflight ? { preflight: provider.preflight } : {}),
    ...(appServer ? { appServer } : {}),
    ...(recovery ? { recovery } : {}),
    ...(provider.artifactCleanup ? { cleanup: provider.artifactCleanup } : {}),
  };
}
