import type {
  KbCapabilityCatalogView,
  KbCapabilityDescriptor,
  KbCapabilityName,
  KbCapabilityRegistry,
} from '../../kb/capability/contract.js';
import { kbCapabilityDescriptorSchema } from '../../kb/capability/contract.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { EngineManifest } from '../contract.js';
import { validateRequireBindings } from '../require-binding-validation.js';

export interface CapabilityCatalogEntry {
  readonly descriptor: KbCapabilityDescriptor;
  readonly origin: 'builtin' | 'external';
  readonly declaredByManifest?: string;
}

export interface CapabilityCatalogSnapshot {
  readonly entries: readonly CapabilityCatalogEntry[];
}

function normalizeDescriptor(descriptor: KbCapabilityDescriptor): KbCapabilityDescriptor {
  return kbCapabilityDescriptorSchema.parse(descriptor);
}

function descriptorsEqual(left: KbCapabilityDescriptor, right: KbCapabilityDescriptor): boolean {
  const normalizedLeft = normalizeDescriptor(left);
  const normalizedRight = normalizeDescriptor(right);
  return (
    normalizedLeft.name === normalizedRight.name &&
    normalizedLeft.namespace === normalizedRight.namespace &&
    normalizedLeft.typeTag === normalizedRight.typeTag &&
    normalizedLeft.label === normalizedRight.label &&
    normalizedLeft.description === normalizedRight.description
  );
}

function assertCatalogEntryCompatible(
  existing: CapabilityCatalogEntry,
  next: CapabilityCatalogEntry,
): CapabilityCatalogEntry {
  if (existing.origin !== next.origin) {
    throw documentedCoralSetupError({
      code: 'capability_name_occupied',
      name: next.descriptor.name,
      existingOrigin: existing.origin,
      nextOrigin: next.origin,
    });
  }

  if (existing.declaredByManifest !== next.declaredByManifest) {
    throw documentedCoralSetupError({
      code: 'capability_name_occupied',
      name: next.descriptor.name,
      declaredByManifest: next.declaredByManifest,
      existingDeclaredByManifest: existing.declaredByManifest,
    });
  }

  if (!descriptorsEqual(existing.descriptor, next.descriptor)) {
    throw documentedCoralSetupError({
      code: 'capability_descriptor_mismatch',
      name: next.descriptor.name,
      declaredByManifest: next.declaredByManifest,
    });
  }

  return existing;
}

export function collectCapabilityCatalog(
  manifests: readonly EngineManifest[],
  builtinDescriptors: readonly KbCapabilityDescriptor[],
): CapabilityCatalogSnapshot {
  const entries = new Map<KbCapabilityName, CapabilityCatalogEntry>();

  for (const descriptor of builtinDescriptors) {
    const normalized = normalizeDescriptor(descriptor);
    const next: CapabilityCatalogEntry = { descriptor: normalized, origin: 'builtin' };
    const existing = entries.get(normalized.name);
    entries.set(normalized.name, existing === undefined ? next : assertCatalogEntryCompatible(existing, next));
  }

  for (const manifest of manifests) {
    for (const descriptor of manifest.provides?.capabilities ?? []) {
      const normalized = normalizeDescriptor(descriptor);
      if (normalized.namespace === 'kb') {
        throw documentedCoralSetupError({
          code: 'capability_namespace_reserved',
          expansion: manifest.id,
          name: normalized.name,
        });
      }
      const next: CapabilityCatalogEntry = {
        descriptor: normalized,
        origin: 'external',
        declaredByManifest: manifest.id,
      };
      const existing = entries.get(normalized.name);
      entries.set(normalized.name, existing === undefined ? next : assertCatalogEntryCompatible(existing, next));
    }
  }

  return Object.freeze({ entries: Object.freeze([...entries.values()]) });
}

function assertBuiltinApplied(registry: KbCapabilityRegistry, entry: CapabilityCatalogEntry): void {
  const record = registry.runtimeView().get(entry.descriptor.name);
  if (
    record === undefined ||
    record.origin !== 'builtin' ||
    record.permanence !== 'runtime' ||
    !descriptorsEqual(record.descriptor, entry.descriptor)
  ) {
    throw documentedCoralSetupError({
      code: 'capability_descriptor_mismatch',
      name: entry.descriptor.name,
      origin: record?.origin,
    });
  }
}

function applyManifestDeclaration(registry: KbCapabilityRegistry, entry: CapabilityCatalogEntry): void {
  if (entry.declaredByManifest === undefined) {
    throw documentedCoralSetupError({
      code: 'capability_descriptor_mismatch',
      name: entry.descriptor.name,
    });
  }
  const record = registry.runtimeView().get(entry.descriptor.name);
  if (record === undefined) {
    registry.registerManifest(entry.descriptor, entry.declaredByManifest);
    return;
  }

  if (
    record.origin === 'external' &&
    record.permanence === 'manifest' &&
    record.declaredByManifest === entry.declaredByManifest &&
    descriptorsEqual(record.descriptor, entry.descriptor)
  ) {
    return;
  }

  if (!descriptorsEqual(record.descriptor, entry.descriptor)) {
    throw documentedCoralSetupError({
      code: 'capability_descriptor_mismatch',
      name: entry.descriptor.name,
      declaredByManifest: entry.declaredByManifest,
    });
  }

  throw documentedCoralSetupError({
    code: 'capability_name_occupied',
    name: entry.descriptor.name,
    declaredByManifest: entry.declaredByManifest,
    existingDeclaredByManifest: record.declaredByManifest,
    existingOrigin: record.origin,
  });
}

export function applyCapabilityDeclarations(registry: KbCapabilityRegistry, catalog: CapabilityCatalogSnapshot): void {
  for (const entry of catalog.entries) {
    if (entry.origin === 'builtin') {
      assertBuiltinApplied(registry, entry);
      continue;
    }
    applyManifestDeclaration(registry, entry);
  }
}

export function assertCapabilityCatalogApplied(manifest: EngineManifest, catalog: KbCapabilityCatalogView): void {
  const descriptors = catalog.listDescriptors();
  for (const descriptor of manifest.provides?.capabilities ?? []) {
    const registered = descriptors.find((candidate) => candidate.name === descriptor.name);
    if (registered === undefined) {
      throw documentedCoralSetupError({
        code: 'capability_descriptor_unregistered',
        expansion: manifest.id,
        name: descriptor.name,
      });
    }
    if (!descriptorsEqual(registered, descriptor)) {
      throw documentedCoralSetupError({
        code: 'capability_descriptor_mismatch',
        expansion: manifest.id,
        name: descriptor.name,
      });
    }
  }
}

export function validateManifestFills(manifest: EngineManifest, catalog: KbCapabilityCatalogView): void {
  for (const name of manifest.fills ?? []) {
    if (!catalog.hasDescriptor(name)) {
      throw documentedCoralSetupError({
        code: 'capability_fill_unknown',
        expansion: manifest.id,
        name,
      });
    }
  }
}

export function validateRetrievalRoleRequirements(manifest: EngineManifest, catalog: KbCapabilityCatalogView): void {
  for (const descriptor of manifest.provides?.retrievalRoles ?? []) {
    for (const name of descriptor.requires ?? []) {
      if (!catalog.hasDescriptor(name)) {
        throw documentedCoralSetupError({
          code: 'require_binding_unknown',
          expansion: manifest.id,
          roleId: descriptor.id,
          name,
        });
      }
    }
  }
}

export function initializeCapabilityCatalog(
  registry: KbCapabilityRegistry,
  manifests: readonly EngineManifest[],
  builtinDescriptors: readonly KbCapabilityDescriptor[],
): KbCapabilityCatalogView {
  const snapshot = collectCapabilityCatalog(manifests, builtinDescriptors);
  applyCapabilityDeclarations(registry, snapshot);
  const catalog = registry.catalogView();

  for (const manifest of manifests) {
    assertCapabilityCatalogApplied(manifest, catalog);
  }
  for (const manifest of manifests) {
    validateManifestFills(manifest, catalog);
  }
  for (const manifest of manifests) {
    validateRetrievalRoleRequirements(manifest, catalog);
  }
  validateRequireBindings(manifests, catalog);

  return catalog;
}
