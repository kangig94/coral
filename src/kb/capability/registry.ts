import { createRuntimeBinding, type RuntimeBinding } from '../../runtime/binding.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Disposable } from '../../runtime/ports.js';
import type {
  KbCapabilityCatalogView,
  KbCapabilityDescriptor,
  KbCapabilityName,
  KbCapabilityRegistry,
  KbCapabilityRuntimeView,
  KbCapabilityStatus,
  RegisteredKbCapability,
} from './contract.js';
import { kbCapabilityDescriptorSchema } from './contract.js';

type DeepReadonly<T> = T extends (...args: readonly never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    deepFreeze(child);
  }

  return Object.freeze(value) as DeepReadonly<T>;
}

function freezeDescriptor(descriptor: KbCapabilityDescriptor): KbCapabilityDescriptor {
  return deepFreeze(kbCapabilityDescriptorSchema.parse(descriptor)) as KbCapabilityDescriptor;
}

function eraseBinding<T>(binding: RuntimeBinding<T>): RuntimeBinding<unknown> {
  return binding as RuntimeBinding<unknown>;
}

function statusFor(record: RegisteredKbCapability): KbCapabilityStatus {
  const heldBy = record.binding.heldBy;
  return Object.freeze({
    name: record.descriptor.name,
    namespace: record.descriptor.namespace,
    declared: true,
    bound: heldBy !== undefined,
    ...(heldBy === undefined ? {} : { heldBy }),
    ...(record.declaredByManifest === undefined ? {} : { declaredByManifest: record.declaredByManifest }),
  });
}

export function createCapabilityRegistry(): KbCapabilityRegistry {
  const records = new Map<KbCapabilityName, RegisteredKbCapability>();

  const list = (): readonly RegisteredKbCapability[] => Object.freeze([...records.values()]);

  const assertNameAvailable = (descriptor: KbCapabilityDescriptor): void => {
    if (records.has(descriptor.name)) {
      throw documentedCoralSetupError({
        code: 'capability_name_occupied',
        name: descriptor.name,
      });
    }
  };

  const runtimeView: KbCapabilityRuntimeView = Object.freeze({
    get(name: KbCapabilityName) {
      return records.get(name);
    },
    bind<T>(name: KbCapabilityName, value: T, scope: Disposable, holder: string) {
      const record = records.get(name);
      if (record === undefined) {
        throw documentedCoralSetupError({
          code: 'require_binding_unknown',
          name,
        });
      }
      record.binding.bind(value, scope, holder);
    },
    read<T>(name: KbCapabilityName): T {
      const record = records.get(name);
      if (record === undefined) {
        throw documentedCoralSetupError({
          code: 'require_binding_unknown',
          name,
        });
      }
      return record.binding.read() as T;
    },
    status(name: KbCapabilityName) {
      const record = records.get(name);
      return record === undefined ? undefined : statusFor(record);
    },
    list,
  });

  const catalogView: KbCapabilityCatalogView = Object.freeze({
    listDescriptors: () => Object.freeze([...records.values()].map((record) => record.descriptor)),
    hasDescriptor: (name: KbCapabilityName) => records.has(name),
  });

  return Object.freeze({
    registerBuiltin<T>(descriptor: KbCapabilityDescriptor, binding: RuntimeBinding<T>) {
      const frozenDescriptor = freezeDescriptor(descriptor);
      assertNameAvailable(frozenDescriptor);
      records.set(frozenDescriptor.name, {
        descriptor: frozenDescriptor,
        origin: 'builtin',
        permanence: 'runtime',
        binding: eraseBinding(binding),
      });
    },
    registerManifest(descriptor: KbCapabilityDescriptor, declaredByManifest: string): void {
      const frozenDescriptor = freezeDescriptor(descriptor);
      if (frozenDescriptor.namespace === 'kb') {
        throw documentedCoralSetupError({
          code: 'capability_namespace_reserved',
          name: frozenDescriptor.name,
          declaredByManifest,
        });
      }
      assertNameAvailable(frozenDescriptor);
      records.set(frozenDescriptor.name, {
        descriptor: frozenDescriptor,
        origin: 'external',
        permanence: 'manifest',
        declaredByManifest,
        binding: createRuntimeBinding<unknown>(frozenDescriptor.name),
      });
    },
    unregisterManifest(name: KbCapabilityName, declaredByManifest: string): boolean {
      const record = records.get(name);
      if (
        record === undefined ||
        record.origin !== 'external' ||
        record.permanence !== 'manifest' ||
        record.declaredByManifest !== declaredByManifest
      ) {
        return false;
      }
      return records.delete(name);
    },
    list,
    runtimeView() {
      return runtimeView;
    },
    catalogView() {
      return catalogView;
    },
  });
}
