import { z } from 'zod';
import { retrievalRoleDescriptorSchema } from '../kb/search/contract.js';
import type { EngineManifest } from './contract.js';

const onboardingStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('require-binding'),
      binding: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('env-var'),
      name: z.string().min(1),
      message: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('confirm-download'),
      message: z.string().min(1),
    })
    .strict(),
]);

export const engineManifestSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    specifier: z.string().min(1),
    tier: z.enum(['bundled', 'installed']),
    description: z.string().min(1),
    // EngineInstaller carries runtime functions and host-specific state, so
    // manifest validation only verifies the declarative catalog fields.
    installer: z.any().optional(),
    onboarding: z.array(onboardingStepSchema).optional(),
    fills: z.array(z.string().min(1)).optional(),
    provides: z.array(retrievalRoleDescriptorSchema).optional(),
  })
  .strict() satisfies z.ZodType<EngineManifest>;

export function parseEngineManifest(input: unknown): EngineManifest {
  return engineManifestSchema.parse(input);
}

export function parseEngineManifests(inputs: readonly unknown[]): readonly EngineManifest[] {
  return z.array(engineManifestSchema).parse(inputs);
}
