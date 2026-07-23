import type { ProviderArtifactHandleInput, ProviderRequest } from '../contract.js';
import type { ProviderCliRequest } from '../protocol.js';
import { jsonValueSchema, type JsonValue } from '../../infra/json-value.js';

function snapshotPlainValue(
  value: unknown,
  label: string,
  options: { readonly allowFunctions: boolean; readonly atomicPropertyNames?: ReadonlySet<string> },
): unknown {
  if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'function') {
    if (!options.allowFunctions) throw new TypeError(`${label} must not contain functions.`);
    return Object.freeze(value);
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must contain only snapshot-safe data.`);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol properties.`);
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor))
        throw new TypeError(`${label}.${key} must be a data property.`);
      if (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)) {
        throw new TypeError(`${label}.${key} is not an array index.`);
      }
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number'
    ) {
      throw new TypeError(`${label}.length must be a numeric data property.`);
    }
    const snapshot = new Array<unknown>(lengthDescriptor.value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length') continue;
      if (!('value' in descriptor)) throw new TypeError(`${label}.${key} must be a data property.`);
      Object.defineProperty(snapshot, key, {
        value: snapshotPlainValue(descriptor.value, `${label}[${key}]`, options),
        enumerable: descriptor.enumerable,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object; received a non-plain object.`);
  }
  const snapshot = Object.create(prototype) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol properties.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor))
      throw new TypeError(`${label}.${key} must be a data property.`);
    Object.defineProperty(snapshot, key, {
      value:
        options.atomicPropertyNames?.has(key) === true
          ? descriptor.value
          : snapshotPlainValue(descriptor.value, `${label}.${key}`, options),
      enumerable: descriptor.enumerable,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

export function snapshotPlainReceiver<Value extends object>(
  value: Value,
  label: string,
  atomicPropertyNames: ReadonlySet<string> = new Set(),
): Readonly<Value> {
  return snapshotPlainValue(value, label, { allowFunctions: true, atomicPropertyNames }) as Readonly<Value>;
}

export function snapshotBoundaryData<Value>(value: Value, label: string): Value {
  return snapshotPlainValue(value, label, { allowFunctions: false }) as Value;
}

export function snapshotAccess<Access extends JsonValue>(value: Access): Access {
  return snapshotBoundaryData(
    jsonValueSchema.parse(snapshotBoundaryData(value, 'Provider access')),
    'Provider access',
  ) as Access;
}

export function snapshotRequest(request: ProviderRequest): ProviderRequest {
  return snapshotBoundaryData(request, 'Provider request');
}

export function snapshotCliRequest(request: ProviderCliRequest): ProviderCliRequest {
  return snapshotPlainReceiver(request, 'Provider CLI request') as ProviderCliRequest;
}

export function snapshotArtifactHandles(
  handles: readonly ProviderArtifactHandleInput[] | undefined,
): readonly ProviderArtifactHandleInput[] | undefined {
  return handles === undefined ? undefined : snapshotBoundaryData(handles, 'Provider artifact handles');
}

export function snapshotProviderResult<Value>(value: Value, label: string): Value {
  return snapshotBoundaryData(value, label);
}
