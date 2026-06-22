import { BUNDLED_ENGINES } from '../../expansion/bundled.js';
import { INSTALL_ONLY_PACKAGES } from '../../expansion/install-only.js';
import type { EngineManifest, OnboardingStep } from '../../expansion/contract.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';

type OnboardingManifest = { readonly id: string; readonly onboarding?: readonly OnboardingStep[] };

export interface OnboardingContext {
  readBinding(id: string): Promise<{ bound: boolean; heldBy?: string }>;
  readonly catalog?: readonly EngineManifest[];
  readonly interactive?: boolean;
  readonly prompt: {
    choose<T>(message: string, options: readonly T[]): Promise<T | null>;
    confirm?(message: string): Promise<boolean>;
  };
  readonly env?: { get(name: string): string | undefined };
  runOnboarding(id: string): Promise<void>;
  equip(id: string): Promise<void>;
}

function catalogFor(ctx: OnboardingContext): readonly EngineManifest[] {
  return ctx.catalog ?? BUNDLED_ENGINES;
}

function resolveEngine(id: string, ctx: OnboardingContext): OnboardingManifest | null {
  return (
    catalogFor(ctx).find((entry) => entry.id === id) ?? INSTALL_ONLY_PACKAGES.find((entry) => entry.id === id) ?? null
  );
}

async function requireBinding(
  engine: OnboardingManifest,
  step: Extract<OnboardingStep, { kind: 'require-binding' }>,
  ctx: OnboardingContext,
): Promise<void> {
  const current = await ctx.readBinding(step.binding);
  if (current.bound) {
    return;
  }

  const choices = catalogFor(ctx).filter((entry) => entry.fills?.includes(step.binding));
  if (ctx.interactive === false) {
    throw documentedCoralSetupError('binding_required', {
      binding: step.binding,
      requiredBy: engine.id,
      candidates: choices.map((entry) => entry.id),
    });
  }

  const chosen = await ctx.prompt.choose(`Expansion '${engine.id}' needs '${step.binding}':`, choices);
  if (!chosen) {
    throw documentedCoralSetupError('user_cancelled', { during: `${engine.id}-onboarding` });
  }

  await ctx.runOnboarding(chosen.id);
  await ctx.equip(chosen.id);
}

async function requireEnv(
  engine: OnboardingManifest,
  step: Extract<OnboardingStep, { kind: 'env-var' }>,
  ctx: OnboardingContext,
): Promise<void> {
  const value = ctx.env?.get(step.name) ?? process.env[step.name];
  if (typeof value === 'string' && value.trim().length > 0) {
    return;
  }

  throw documentedCoralSetupError('engine_env_var_missing', {
    engine: engine.id,
    envVar: step.name,
    ...(step.message === undefined ? {} : { message: step.message }),
  });
}

async function confirmDownload(
  engine: OnboardingManifest,
  step: Extract<OnboardingStep, { kind: 'confirm-download' }>,
  ctx: OnboardingContext,
): Promise<void> {
  const confirmed = await (ctx.prompt.confirm?.(step.message) ?? true);
  if (!confirmed) {
    throw documentedCoralSetupError('user_cancelled', { during: `${engine.id}-onboarding` });
  }
}

async function runStep(engine: OnboardingManifest, step: OnboardingStep, ctx: OnboardingContext): Promise<void> {
  if (step.kind === 'require-binding') {
    await requireBinding(engine, step, ctx);
  } else if (step.kind === 'env-var') {
    await requireEnv(engine, step, ctx);
  } else {
    await confirmDownload(engine, step, ctx);
  }
}

export async function runExpansionOnboarding(id: string, ctx: OnboardingContext): Promise<void> {
  const engine = resolveEngine(id, ctx);
  if (!engine) {
    throw documentedCoralSetupError('unknown_expansion', { name: id });
  }

  for (const step of engine.onboarding ?? []) {
    await runStep(engine, step, ctx);
  }
}
