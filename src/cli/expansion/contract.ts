import { z } from 'zod';

export {
  catalogEntrySchema,
  catalogEntryStatusSchema,
  catalogResultSchema,
  infoResultSchema,
  installErrorSchema,
  installResponseSchema,
  installResultSchema,
  onboardingSchema,
  type CatalogEntry,
  type CatalogEntryStatus,
  type InstallError,
  type InstallResponse,
  type InstallResult,
  type Onboarding,
  type OnboardingStep,
} from '../../coordinator/expansion/rpc.js';

export const expansionArgsSchema = z
  .object({
    name: z.string().min(1).optional(),
  })
  .strict();
export type ExpansionArgs = z.infer<typeof expansionArgsSchema>;
