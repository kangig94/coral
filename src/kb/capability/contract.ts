import { z } from 'zod';
import type { RuntimeBinding } from '../../runtime/binding.js';
import type { Disposable } from '../../runtime/ports.js';

export type KbCapabilityName = string & { readonly __kbCapabilityName: 'KbCapabilityName' };

export type KbCapabilityNamespace = 'kb' | 'external';

const CAPABILITY_NAME_MAX_LENGTH = 64;
const CAPABILITY_NAMESPACE_MAX_LENGTH = 16;
const CAPABILITY_SEGMENT_MAX_LENGTH = 32;
const CAPABILITY_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/;

function isValidCapabilityName(raw: string): boolean {
  if (raw.length < 3 || raw.length > CAPABILITY_NAME_MAX_LENGTH) {
    return false;
  }
  if (raw.trim() !== raw || !CAPABILITY_NAME_PATTERN.test(raw)) {
    return false;
  }

  const [namespace, ...segments] = raw.split('.');
  if (namespace === undefined || segments.length === 0 || namespace.length > CAPABILITY_NAMESPACE_MAX_LENGTH) {
    return false;
  }

  for (const segment of segments) {
    if (segment.length === 0 || segment.length > CAPABILITY_SEGMENT_MAX_LENGTH) {
      return false;
    }
  }
  return true;
}

export function canonicalizeCapabilityName<T extends string>(raw: T): T & KbCapabilityName {
  if (!isValidCapabilityName(raw)) {
    throw new TypeError(`Invalid KB capability name: ${raw}`);
  }
  return raw as T & KbCapabilityName;
}

function capabilityNamespaceForName(name: KbCapabilityName): KbCapabilityNamespace {
  return name.startsWith('kb.') ? 'kb' : 'external';
}

export const kbCapabilityNameSchema = z
  .string()
  .refine((value) => isValidCapabilityName(value), {
    message:
      'Capability name must be lowercase, <=64 chars, and use dot-separated non-empty segments with optional hyphens or underscores.',
  })
  .describe('validate-kb-capability-name')
  .transform((value) => canonicalizeCapabilityName(value))
  .describe('brand-canonical-kb-capability-name');

export interface KbCapabilityDescriptor {
  readonly name: KbCapabilityName;
  readonly typeTag?: string;
  readonly label?: string;
  readonly description?: string;
  readonly namespace: KbCapabilityNamespace;
}

const kbCapabilityDescriptorInputSchema = z
  .object({
    name: kbCapabilityNameSchema,
    typeTag: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    namespace: z.enum(['kb', 'external']).optional(),
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    const derivedNamespace = capabilityNamespaceForName(descriptor.name);
    if (descriptor.namespace !== undefined && descriptor.namespace !== derivedNamespace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['namespace'],
        message: `Capability namespace must be '${derivedNamespace}' for '${descriptor.name}'.`,
      });
    }
  })
  .describe('require-derived-kb-capability-namespace');

export const kbCapabilityDescriptorSchema = kbCapabilityDescriptorInputSchema
  .transform<KbCapabilityDescriptor>((descriptor) => ({
    name: descriptor.name,
    ...(descriptor.typeTag === undefined ? {} : { typeTag: descriptor.typeTag }),
    ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    ...(descriptor.description === undefined ? {} : { description: descriptor.description }),
    namespace: capabilityNamespaceForName(descriptor.name),
  }))
  .describe('derive-kb-capability-namespace');

export interface RegisteredKbCapability {
  readonly descriptor: KbCapabilityDescriptor;
  readonly origin: 'builtin' | 'external';
  readonly permanence: 'runtime' | 'manifest';
  readonly declaredByManifest?: string;
  readonly binding: RuntimeBinding<unknown>;
}

export interface KbCapabilityStatus {
  readonly name: KbCapabilityName;
  readonly namespace: KbCapabilityNamespace;
  readonly declared: boolean;
  readonly bound: boolean;
  readonly heldBy?: string;
  readonly declaredByManifest?: string;
}

export interface KbCapabilityRegistry {
  registerBuiltin<T>(descriptor: KbCapabilityDescriptor, binding: RuntimeBinding<T>): void;
  registerManifest(descriptor: KbCapabilityDescriptor, declaredByManifest: string): void;
  unregisterManifest(name: KbCapabilityName, declaredByManifest: string): boolean;
  list(): readonly RegisteredKbCapability[];
  runtimeView(): KbCapabilityRuntimeView;
  catalogView(): KbCapabilityCatalogView;
}

export interface KbCapabilityRuntimeView {
  get(name: KbCapabilityName): RegisteredKbCapability | undefined;
  bind<T>(name: KbCapabilityName, value: T, scope: Disposable, holder: string): void;
  read<T>(name: KbCapabilityName): T;
  status(name: KbCapabilityName): KbCapabilityStatus | undefined;
  list(): readonly RegisteredKbCapability[];
}

export interface KbCapabilityCatalogView {
  listDescriptors(): readonly KbCapabilityDescriptor[];
  hasDescriptor(name: KbCapabilityName): boolean;
}
