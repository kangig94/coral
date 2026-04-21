import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import {
  terminalOutcomeSchema,
  type PreflightRuntime,
  type ProviderRequest,
  type ProviderSpec,
  type TerminalOutcome,
  usageSummarySchema,
} from './contract.js';
import { streamProviderEvents } from './stream.js';
import { buildJobDiagnostics, buildJobTerminal } from './terminal.js';

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
    nonResumable: z.boolean().optional(),
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

export const CORAL_SCRIPTED_PROVIDER_SPEC_ENV = 'CORAL_SCRIPTED_PROVIDER_SPEC';

function resolveConversationRef(
  request: ProviderRequest,
  spec: ScriptedProviderSpec,
): string {
  return spec.result?.conversationRef ?? request.conversationRef ?? `scripted-${request.sessionId}`;
}

function toScriptedProviderSpec(specInput: ScriptedProviderSpec): ProviderSpec {
  const spec = scriptedProviderSpecSchema.parse(specInput);

  return {
    name: spec.name,
    run(request, runtime) {
      const progress = spec.progress ?? [];
      const conversationRef = resolveConversationRef(request, spec);

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
          resumable: spec.result?.nonResumable !== true,
          providerContinuity: null,
        });
        emit({
          kind: 'terminal',
          terminal: buildJobTerminal({
            content: spec.result?.content ?? '',
            outcome: (spec.result?.outcome ?? { kind: 'completed' }) as TerminalOutcome,
            ...(spec.result?.model === undefined ? {} : { model: spec.result.model }),
            ...(spec.result?.durationMs === undefined ? {} : { durationMs: spec.result.durationMs }),
            ...(spec.result?.exitCode === undefined ? {} : { exitCode: spec.result.exitCode }),
            ...(spec.result?.warnings === undefined ? {} : { warnings: [...spec.result.warnings] }),
            ...(spec.result?.usage === undefined ? {} : { usage: { ...spec.result.usage } }),
          }),
          diagnostics: buildJobDiagnostics({}),
        });
      });
    },
    ...(spec.preflightError
      ? {
          async preflight(_runtime: PreflightRuntime): Promise<void> {
            throw new Error(spec.preflightError);
          },
        }
      : {}),
  };
}

export function readScriptedProviderSpecFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ScriptedProviderSpec | null {
  const raw = env[CORAL_SCRIPTED_PROVIDER_SPEC_ENV];
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(
      `${CORAL_SCRIPTED_PROVIDER_SPEC_ENV} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return scriptedProviderSpecSchema.parse(parsed);
}

export function resolveScriptedProviderOverride(
  env: NodeJS.ProcessEnv = process.env,
): ProviderSpec | null {
  const spec = readScriptedProviderSpecFromEnv(env);
  return spec === null ? null : toScriptedProviderSpec(spec);
}
