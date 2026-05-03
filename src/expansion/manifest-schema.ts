import { z } from 'zod';
import { retrievalRoleDescriptorSchema } from '../kb/search/contract.js';
import { kbCapabilityDescriptorSchema, kbCapabilityNameSchema } from '../kb/capability/contract.js';
import type { EngineManifest } from './contract.js';

const onboardingStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('require-binding'),
      binding: kbCapabilityNameSchema,
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

const manifestProvidesSchema = z
  .object({
    retrievalRoles: z.array(retrievalRoleDescriptorSchema).optional(),
    capabilities: z.array(kbCapabilityDescriptorSchema).optional(),
  })
  .strict()
  .superRefine((provides, ctx) => {
    for (const [index, descriptor] of (provides.capabilities ?? []).entries()) {
      if (descriptor.namespace !== 'kb' && !descriptor.name.startsWith('kb.')) {
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capabilities', index, 'name'],
        message: 'capability_namespace_reserved',
      });
    }
  });

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
    fills: z.array(kbCapabilityNameSchema).optional(),
    provides: manifestProvidesSchema.optional(),
  })
  .strict() satisfies z.ZodType<EngineManifest>;

export function parseEngineManifest(input: unknown): EngineManifest {
  return engineManifestSchema.parse(input);
}

export function parseEngineManifests(inputs: readonly unknown[]): readonly EngineManifest[] {
  return z.array(engineManifestSchema).parse(inputs);
}
