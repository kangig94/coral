import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

import { legacyTerminalOutcomeSchema } from '../shared/legacy-terminal-outcome-compat.js';
import { nowIsoString } from '../shared/utils.js';
import {
  providerProgressEvent,
  providerTerminalEvent,
  streamProviderEvents,
  usageSummarySchema,
  type ProviderRequest,
  type ProviderTerminalEventBody,
} from './protocol.js';
import type { PreflightRuntime, Provider } from './provider-contracts.js';

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
    outcome: legacyTerminalOutcomeSchema.optional(),
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

function resolveTerminalResult(
  request: ProviderRequest,
  spec: ScriptedProviderSpec,
): Omit<ProviderTerminalEventBody, 'type'> {
  const result = spec.result;
  return {
    content: result?.content ?? '',
    conversationRef: result?.conversationRef ?? request.conversationRef ?? `scripted-${request.sessionId}`,
    ...(result?.model === undefined ? {} : { model: result.model }),
    ...(result?.durationMs === undefined ? {} : { durationMs: result.durationMs }),
    ...(result?.nonResumable === undefined ? {} : { nonResumable: result.nonResumable }),
    ...(result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
    ...(result?.warnings === undefined ? {} : { warnings: [...result.warnings] }),
    ...(result?.usage === undefined ? {} : { usage: { ...result.usage } }),
    outcome: result?.outcome ?? { kind: 'completed' },
  };
}

export function createScriptedProvider(specInput: ScriptedProviderSpec): Provider {
  const spec = scriptedProviderSpecSchema.parse(specInput);

  return {
    name: spec.name,
    preflight: async (_runtime: PreflightRuntime): Promise<void> => {
      if (spec.preflightError) {
        throw new Error(spec.preflightError);
      }
    },
    execute(request, runtime) {
      const progress = spec.progress ?? [];
      const terminal = resolveTerminalResult(request, spec);

      return streamProviderEvents(async (emit) => {
        for (const entry of progress) {
          if (entry.delayMs && entry.delayMs > 0) {
            await delay(entry.delayMs, undefined, { signal: runtime.signal }).catch(() => undefined);
          }
          emit(providerProgressEvent(entry.message, entry.ts ?? nowIsoString()));
        }

        emit(providerTerminalEvent(terminal));
      });
    },
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
    );
  }

  return scriptedProviderSpecSchema.parse(parsed);
}
