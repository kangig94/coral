import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';

import type { BundledExpansion } from '../../expansion/contract.js';
import { coralEnvPath, readCoralEnvFile } from '../../kb/env.js';
import { GEMINI_API_KEY_ENV } from '../../kb/embedding/gemini/expansion.js';
import { ensureOnnxModelAvailable } from '../../kb/embedding/onnx/expansion.js';
import { resolveBuildFlavor } from '../../infra/build-flavor.js';
import { CoralSetupError } from '../../runtime/errors.js';
import { createRealRuntime } from '../../runtime/real.js';

export interface OnboardingFlow {
  readonly id: string;
  run(ctx: OnboardingContext): Promise<void>;
}

export interface OnboardingContext {
  readBinding(id: string): Promise<{ bound: boolean; heldBy?: string }>;
  readonly catalog: readonly BundledExpansion[];
  readonly prompt: { choose<T>(message: string, options: readonly T[]): Promise<T | null> };
  runOnboarding(id: string): Promise<void>;
  equip(id: string): Promise<void>;
}

interface OnboardingFlowDeps {
  readSecret?(message: string): Promise<string | null>;
  writeEnvVar?(key: string, value: string): Promise<void>;
  ensureOnnxModel?(): Promise<void>;
}

function cancellationError(during: string, userMessage: string, remediation: string): CoralSetupError {
  return new CoralSetupError({
    code: 'user-cancelled',
    userMessage,
    remediation,
    context: { during },
  });
}

async function readSecretPrompt(message: string): Promise<string | null> {
  const rl = createInterface({ input, output });
  try {
    const value = (await rl.question(`${message} `)).trim();
    return value === '' ? null : value;
  } finally {
    rl.close();
  }
}

async function writeCoralEnvVar(key: string, value: string): Promise<void> {
  const envPath = coralEnvPath();
  const current = readCoralEnvFile();
  current[key] = value;
  mkdirSync(dirname(envPath), { recursive: true });
  const next = Object.entries(current)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([envKey, envValue]) => `${envKey}=${envValue}`)
    .join('\n');
  writeFileSync(envPath, `${next}\n`, 'utf-8');
}

async function ensureDefaultOnnxModel(): Promise<void> {
  const runtime = createRealRuntime(resolveBuildFlavor(process.env));
  await ensureOnnxModelAvailable(runtime.paths.coral.expansion.dataDir('onnx'));
}

export const needleOnboarding: OnboardingFlow = {
  id: 'needle',
  async run(ctx) {
    const kbEmbedding = await ctx.readBinding('kb.embedding');
    if (kbEmbedding.bound) {
      return;
    }

    const choices = ctx.catalog.filter((entry) => entry.metadata.slot === 'kb.embedding');
    const chosen = await ctx.prompt.choose('Vector search needs an embedder:', choices);
    if (!chosen) {
      throw cancellationError(
        'needle-onboarding',
        'Needle onboarding was cancelled before an embedder was chosen.',
        "Retry the needle onboarding flow and choose an embedder when you're ready.",
      );
    }

    await ctx.runOnboarding(chosen.id);
    await ctx.equip(chosen.id);
  },
};

export function createGeminiOnboardingFlow(deps: OnboardingFlowDeps = {}): OnboardingFlow {
  return {
    id: 'gemini',
    async run(_ctx) {
      const existingApiKey = process.env[GEMINI_API_KEY_ENV]?.trim() ?? readCoralEnvFile()[GEMINI_API_KEY_ENV]?.trim();
      if (existingApiKey) {
        return;
      }

      const readSecret = deps.readSecret ?? readSecretPrompt;
      const writeEnvVar = deps.writeEnvVar ?? writeCoralEnvVar;
      const apiKey = await readSecret(`Enter ${GEMINI_API_KEY_ENV} (blank to cancel):`);
      if (!apiKey) {
        throw cancellationError(
          'gemini-onboarding',
          'Gemini onboarding was cancelled before an API key was saved.',
          `Retry onboarding and provide ${GEMINI_API_KEY_ENV}, or export it before equipping gemini.`,
        );
      }

      await writeEnvVar(GEMINI_API_KEY_ENV, apiKey);
      process.env[GEMINI_API_KEY_ENV] = apiKey;
    },
  };
}

export function createOnnxOnboardingFlow(deps: OnboardingFlowDeps = {}): OnboardingFlow {
  return {
    id: 'onnx',
    async run(_ctx) {
      const ensureModel = deps.ensureOnnxModel ?? ensureDefaultOnnxModel;
      process.stderr.write('Downloading local ONNX embedding model if needed...\n');
      await ensureModel();
      process.stderr.write('Local ONNX embedding model is ready.\n');
    },
  };
}

export function createOnboardingFlows(deps: OnboardingFlowDeps = {}): readonly OnboardingFlow[] {
  return [
    createGeminiOnboardingFlow(deps),
    createOnnxOnboardingFlow(deps),
    needleOnboarding,
  ];
}

export function findOnboardingFlow(id: string, flows: readonly OnboardingFlow[]): OnboardingFlow | null {
  return flows.find((flow) => flow.id === id) ?? null;
}

export async function runOnboardingFlow(
  id: string,
  ctx: OnboardingContext,
  flows: readonly OnboardingFlow[] = createOnboardingFlows(),
): Promise<void> {
  const flow = findOnboardingFlow(id, flows);
  if (flow === null) {
    return;
  }
  await flow.run(ctx);
}
