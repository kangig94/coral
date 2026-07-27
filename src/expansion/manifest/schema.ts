import { z } from 'zod';
import { retrievalRoleDescriptorSchema } from '../../kb/search/contract.js';
import { kbCapabilityDescriptorSchema, kbCapabilityNameSchema } from '../../kb/capability/contract.js';
import type { EngineManifest } from '../contract.js';
import { validateCanonicalExpansionPackageId, validateExpansionPackageId } from '../package-id.js';

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

export const expansionPackageIdSchema = z
  .string()
  .superRefine((id, ctx) => {
    const result = validateCanonicalExpansionPackageId(id);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expansion_package_id_${result.reason}`,
      });
    }
  })
  .describe('canonical-expansion-package-id');

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
  })
  .describe('reject-reserved-kb-capability-namespace');

const declarativeEngineManifestShape = {
  id: expansionPackageIdSchema,
  version: z.string().min(1),
  specifier: z.string().min(1),
  tier: z.enum(['bundled', 'installed']),
  description: z.string().min(1),
  onboarding: z.array(onboardingStepSchema).optional(),
  fills: z.array(kbCapabilityNameSchema).optional(),
  provides: manifestProvidesSchema.optional(),
} as const;

/**
 * Store-format compatibility schema. Runtime/catalog ingress applies the
 * stricter package-id refinements below, while this shape deliberately remains
 * byte-for-byte compatible with stores created before those refinements.
 */
export const persistedDeclarativeEngineManifestSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    specifier: z.string().min(1),
    tier: z.enum(['bundled', 'installed']),
    description: z.string().min(1),
    onboarding: z.array(onboardingStepSchema).optional(),
    fills: z.array(kbCapabilityNameSchema).optional(),
    provides: manifestProvidesSchema.optional(),
  })
  .strict();

function validateInstalledId(
  manifest: { readonly id: string; readonly tier: 'bundled' | 'installed' },
  ctx: z.RefinementCtx,
): void {
  if (manifest.tier !== 'installed') {
    return;
  }
  const result = validateExpansionPackageId(manifest.id);
  if (!result.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: `expansion_package_id_${result.reason}`,
    });
  }
}

export const declarativeEngineManifestSchema = z
  .object(declarativeEngineManifestShape)
  .strict()
  .superRefine(validateInstalledId)
  .describe('validate-installed-expansion-package-id');

export const engineManifestSchema = z
  .object({
    ...declarativeEngineManifestShape,
    // EngineInstaller carries runtime functions and host-specific state and is
    // deliberately absent from the persisted catalog codec above.
    installer: z.any().optional(),
  })
  .strict()
  .superRefine(validateInstalledId)
  .describe('validate-runtime-expansion-package-id');

export function parseDeclarativeEngineManifest(input: unknown): EngineManifest {
  return declarativeEngineManifestSchema.parse(input);
}

export function parseEngineManifest(input: unknown): EngineManifest {
  return engineManifestSchema.parse(input);
}

export function parseEngineManifests(inputs: readonly unknown[]): readonly EngineManifest[] {
  return z.array(engineManifestSchema).parse(inputs);
}
