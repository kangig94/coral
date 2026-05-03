/**
 * Expansion RPC contract — schemas, types, and the `ExpansionRequestPort`
 * interface. Owned by the `expansion` domain so transport and CLI can
 * import the contract without crossing into `coordinator/`.
 *
 * Coordinator-side wiring (factories that bind the port to
 * `ExpansionLifecycleService`) lives at `src/coordinator/expansion/rpc.ts`.
 */
import { z } from 'zod';
import { retrievalRoleDescriptorSchema } from '../kb/search/contract.js';
import {
  kbCapabilityDescriptorSchema,
  kbCapabilityNameSchema,
  type KbCapabilityStatus,
} from '../kb/capability/contract.js';
import type { EngineManifestProvides } from './contract.js';

const expansionCatalogStatusLiterals = [
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
const providesSchema: z.ZodType<EngineManifestProvides> = z
  .object({
    retrievalRoles: z.array(retrievalRoleDescriptorSchema).optional(),
    capabilities: z.array(kbCapabilityDescriptorSchema).optional(),
  })
  .strict();
const capabilityStatusSchema: z.ZodType<KbCapabilityStatus> = z
  .object({
    name: kbCapabilityNameSchema,
    namespace: z.enum(['kb', 'external']),
    declared: z.boolean(),
    bound: z.boolean(),
    heldBy: z.string().min(1).optional(),
    declaredByManifest: z.string().min(1).optional(),
  })
  .strict();

const catalogEntryCommonShape = {
  id: z.string(),
  name: z.string().min(1),
  description: z.string().min(1),
  statusDescription: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  method: z.string().min(1).optional(),
  provides: providesSchema.optional(),
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

const postInstallSchema = z
  .array(
    z.union([
      z.literal('register_expansion'),
      z
        .object({
          action: z.literal('register_expansion'),
          manifestPath: z.string().min(1),
        })
        .strict(),
    ]),
  );

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

const expansionEntrySchema = z
  .object({
    ...catalogEntryCommonShape,
    tier: z.enum(['bundled', 'installed']),
    activation: z.literal('equip'),
    status: z.enum(expansionCatalogStatusLiterals),
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
  })
  .strict();

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

export const catalogEntrySchema = z.discriminatedUnion('activation', [expansionEntrySchema, installOnlyEntrySchema]);
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const catalogResultSchema = z
  .object({
    status: z.literal('catalog'),
    packages: z.array(catalogEntrySchema),
  })
  .strict();

export const infoResultSchema = z
  .object({
    status: z.literal('info'),
    package: catalogEntrySchema,
  })
  .strict();

export const expansionStatusSchema = z.enum([
  'equipped',
  'catching_up',
  'inactive',
  'installed-not-active',
  'unavailable',
  'disabled_pending_reinstall',
  'installing',
  'not_equipped',
]);
export type ExpansionStatus = z.infer<typeof expansionStatusSchema>;

export interface ExpansionView {
  readonly name: string;
  readonly tier: 'bundled' | 'installed';
  readonly status: ExpansionStatus;
  readonly lastError?: string;
  readonly provides?: EngineManifestProvides;
  readonly capabilityStatus?: readonly KbCapabilityStatus[];
}

export const expansionViewSchema = z
  .object({
    name: z.string().min(1),
    tier: z.enum(['bundled', 'installed']),
    status: expansionStatusSchema,
    lastError: z.string().min(1).optional(),
    provides: providesSchema.optional(),
    capabilityStatus: z.array(capabilityStatusSchema).optional(),
  })
  .strict() satisfies z.ZodType<ExpansionView>;

const installExpansionViewSchema = z
  .object({
    slot: z.string().min(1).optional(),
    name: z.string().min(1),
    tier: z.enum(['bundled', 'installed']),
    status: expansionStatusSchema,
    provides: providesSchema.optional(),
    capabilityStatus: z.array(capabilityStatusSchema).optional(),
  })
  .strict();

export const equipExpansionRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();
export type EquipExpansionRequest = z.infer<typeof equipExpansionRequestSchema>;

const equipExpansionStatusSchema = z.enum(['equipped', 'catching_up', 'already_equipped']);

export const equipExpansionResultSchema = z
  .object({
    status: equipExpansionStatusSchema,
    expansion: expansionViewSchema,
  })
  .strict();
export type EquipExpansionResult = z.infer<typeof equipExpansionResultSchema>;

export const unequipExpansionRequestSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();
export type UnequipExpansionRequest = z.infer<typeof unequipExpansionRequestSchema>;

export const unequipExpansionResultSchema = z.union([
  z.object({ status: z.literal('uninstalled') }).strict(),
  z.object({ status: z.literal('not_equipped') }).strict(),
]);
export type UnequipExpansionResult = z.infer<typeof unequipExpansionResultSchema>;

export const listExpansionRequestSchema = z.object({}).strict();
export type ListExpansionRequest = z.infer<typeof listExpansionRequestSchema>;

export const listExpansionResultSchema = z
  .object({
    expansions: z.array(expansionViewSchema),
  })
  .strict();
export type ListExpansionResult = z.infer<typeof listExpansionResultSchema>;

export const readBindingRequestSchema = z
  .object({
    binding: z.string().min(1),
  })
  .strict();
export type ReadBindingRequest = z.infer<typeof readBindingRequestSchema>;

export const readBindingResultSchema = z
  .object({
    bound: z.boolean(),
    heldBy: z.string().min(1).optional(),
  })
  .strict();
export type ReadBindingResult = z.infer<typeof readBindingResultSchema>;

export interface ExpansionRequestPort {
  equipExpansion(request: EquipExpansionRequest): Promise<EquipExpansionResult>;
  unequipExpansion(request: UnequipExpansionRequest): Promise<UnequipExpansionResult>;
  listExpansion(request: ListExpansionRequest): Promise<ListExpansionResult>;
  readBinding(request: ReadBindingRequest): Promise<ReadBindingResult>;
}

const installedResultSchema = z
  .object({
    status: z.literal('installed'),
    method: z.string().min(1),
    version: z.string().min(1).optional(),
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
    targetDir: z.string().min(1).optional(),
    postInstall: postInstallSchema.optional(),
    onboarding: onboardingSchema.optional(),
  })
  .strict();

const mutationResultSchema = z.discriminatedUnion('status', [
  installedResultSchema,
  updatedResultSchema,
  alreadyInstalledResultSchema,
  alreadyUpToDateResultSchema,
  z.object({ status: z.literal('uninstalled') }).strict(),
  z.object({ status: z.literal('not_equipped') }).strict(),
]);

export const installResultSchema = z.discriminatedUnion('status', [
  catalogResultSchema,
  infoResultSchema,
  ...mutationResultSchema.options,
  z.object({ status: z.literal('equipped'), expansion: installExpansionViewSchema }).strict(),
  z.object({ status: z.literal('catching_up'), expansion: installExpansionViewSchema }).strict(),
  z.object({ status: z.literal('already_equipped'), expansion: installExpansionViewSchema }).strict(),
]);
export type InstallResult = z.infer<typeof installResultSchema>;

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
export type InstallError = z.infer<typeof installErrorSchema>;

export const installResponseSchema = z.union([installResultSchema, installErrorSchema]);
export type InstallResponse = z.infer<typeof installResponseSchema>;
