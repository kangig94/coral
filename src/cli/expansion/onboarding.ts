import type { BundledExpansion } from '../../expansion/contract.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';

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
      throw documentedCoralSetupError('user_cancelled', { during: 'needle-onboarding' });
    }

    await ctx.runOnboarding(chosen.id);
    await ctx.equip(chosen.id);
  },
};
