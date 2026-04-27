import { z } from 'zod';

import { equipmentViewSchema } from './equipment-contract.js';

const equipmentCatalogStatusLiterals = [
  'inactive',
  'installed-not-active',
  'unavailable',
  'disabled_pending_reinstall',
  'installing',
  'equipped',
  'catching_up',
  'not_equipped',
] as const;

const installOnlyCatalogStatusLiterals = ['not_installed', 'installed', 'installing'] as const;
const postInstallActionLiterals = ['register_equipment'] as const;

const catalogEntryCommonShape = {
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  statusDescription: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
} as const;

const requiredEnvRuleSchema = z
  .object({
    provider: z.string().min(1),
    env: z.array(z.string().min(1)).min(1),
  })
  .strict();

const localRuntimeSchema = z
  .object({
    targetDir: z.string().min(1),
    bootstrapPackageJson: z.boolean(),
    packageManager: z.string().min(1),
    packageName: z.string().min(1),
  })
  .strict();

const onboardingChoiceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    dims: z.number().int().positive().nullable(),
  })
  .strict();

const postInstallSchema = z.array(z.enum(postInstallActionLiterals)).min(1);

/** Models install-time onboarding metadata consumed by `skills/equip/SKILL.md`. */
export const onboardingSchema = z
  .object({
    envPath: z.string().min(1),
    requiredEnv: z.array(requiredEnvRuleSchema).min(1),
    providerEnvKey: z.string().min(1),
    modelEnvKey: z.string().min(1),
    apiKeyEnvKey: z.string().min(1),
    securityNotice: z.string().min(1),
    localRuntime: localRuntimeSchema,
    choices: z.array(onboardingChoiceSchema).min(1),
  })
  .strict();
/** Carries the provider-aware onboarding contract exposed by expansion installs. */
export type Onboarding = z.infer<typeof onboardingSchema>;

const equipmentEntrySchema = z
  .object({
    ...catalogEntryCommonShape,
    activation: z.literal('equipment'),
    status: z.enum(equipmentCatalogStatusLiterals),
    addonPath: z.string().min(1).optional(),
    lastError: z.string().min(1).optional(),
    onboarding: onboardingSchema.optional(),
  })
  .strict();

const installOnlyEntrySchema = z
  .object({
    ...catalogEntryCommonShape,
    activation: z.literal('none'),
    status: z.enum(installOnlyCatalogStatusLiterals),
    command: z.string().min(1).optional(),
  })
  .strict();

const installedResultSchema = z
  .object({
    status: z.literal('installed'),
    method: z.string().min(1),
    version: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    targetDir: z.string().min(1).optional(),
    postInstall: postInstallSchema.optional(),
    onboarding: onboardingSchema.optional(),
  })
  .strict();

const updatedResultSchema = z
  .object({
    status: z.literal('updated'),
    method: z.string().min(1),
    version: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    targetDir: z.string().min(1).optional(),
    postInstall: postInstallSchema.optional(),
    onboarding: onboardingSchema.optional(),
  })
  .strict();

const alreadyInstalledResultSchema = z
  .object({
    status: z.literal('already_installed'),
    method: z.string().min(1),
    version: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    targetDir: z.string().min(1).optional(),
    postInstall: postInstallSchema.optional(),
    onboarding: onboardingSchema.optional(),
  })
  .strict();

const alreadyUpToDateResultSchema = z
  .object({
    status: z.literal('already_up_to_date'),
    method: z.string().min(1),
    version: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    targetDir: z.string().min(1).optional(),
    postInstall: postInstallSchema.optional(),
    onboarding: onboardingSchema.optional(),
  })
  .strict();

const uninstalledResultSchema = z.object({ status: z.literal('uninstalled') }).strict();
const notEquippedResultSchema = z.object({ status: z.literal('not_equipped') }).strict();
const equippedResultSchema = z.object({ status: z.literal('equipped'), equipment: equipmentViewSchema }).strict();
const catchingUpResultSchema = z.object({ status: z.literal('catching_up'), equipment: equipmentViewSchema }).strict();
const alreadyEquippedResultSchema = z
  .object({ status: z.literal('already_equipped'), equipment: equipmentViewSchema })
  .strict();

/** Enumerates every catalog/info entry status literal across equipment and install-only activations. */
export const catalogEntryStatusSchema = z.union([
  z.literal('inactive'),
  z.literal('installed-not-active'),
  z.literal('unavailable'),
  z.literal('disabled_pending_reinstall'),
  z.literal('installing'),
  z.literal('equipped'),
  z.literal('catching_up'),
  z.literal('not_equipped'),
  z.literal('not_installed'),
  z.literal('installed'),
]);
/** Names the merged read-only status surface for catalog entries before activation-aware narrowing. */
export type CatalogEntryStatus = z.infer<typeof catalogEntryStatusSchema>;

/** Narrows catalog/info entries by activation mode so entry status values stay mode-correct. */
export const catalogEntrySchema = z.discriminatedUnion('activation', [equipmentEntrySchema, installOnlyEntrySchema]);
/** Represents a single catalog/info entry with activation-aware status narrowing. */
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/** Encodes the list/read-many response for expansion catalog queries. */
export const catalogResultSchema = z
  .object({
    status: z.literal('catalog'),
    packages: z.array(catalogEntrySchema),
  })
  .strict();
/** Encodes the single-entry read result so consumers retain activation-aware entry narrowing. */
export const infoResultSchema = z
  .object({
    status: z.literal('info'),
    package: catalogEntrySchema,
  })
  .strict();

/** Encodes the install/update/uninstall success surface before activation-specific results are added. */
const mutationResultSchema = z.discriminatedUnion('status', [
  installedResultSchema,
  updatedResultSchema,
  alreadyInstalledResultSchema,
  alreadyUpToDateResultSchema,
  uninstalledResultSchema,
  notEquippedResultSchema,
]);

/** Encodes every public success/read result routed by expansion consumers. */
export const installResultSchema = z.discriminatedUnion('status', [
  catalogResultSchema,
  infoResultSchema,
  ...mutationResultSchema.options,
  equippedResultSchema,
  catchingUpResultSchema,
  alreadyEquippedResultSchema,
]);
/** Represents the full public success/read result family for expansion commands and workflows. */
export type InstallResult = z.infer<typeof installResultSchema>;

/** Encodes the canonical public failure shape for expansion commands and workflows. */
export const installErrorSchema = z
  .object({
    status: z.literal('error'),
    code: z.string().min(1),
    userMessage: z.string().min(1),
    remediation: z.string().min(1),
    context: z.record(z.string(), z.unknown()).optional(),
    suggestions: z.array(z.string().min(1)).optional(),
  })
  .strict();
/** Represents the canonical public failure shape emitted by expansion commands and workflows. */
export type InstallError = z.infer<typeof installErrorSchema>;

/** Validates CLI expansion arguments before dispatching to the workflow layer. */
export const expansionArgsSchema = z
  .object({
    name: z.string().min(1).optional(),
  })
  .strict();
/** Represents the validated argument payload accepted by expansion CLI subcommands. */
export type ExpansionArgs = z.infer<typeof expansionArgsSchema>;

/** Parses the full public expansion response envelope, whether the result is success/read or failure. */
export const installResponseSchema = z.union([installResultSchema, installErrorSchema]);
/** Represents the canonical expansion consumer entrypoint for success-or-error response parsing. */
export type InstallResponse = z.infer<typeof installResponseSchema>;
