function propertyPath(label: string, key: PropertyKey): string {
  return `${label}.${String(key)}`;
}

export function readOwnDataProperty<Source extends object, Key extends keyof Source>(
  source: Source,
  key: Key,
  label: string,
): Source[Key] {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) {
    throw new TypeError(`${propertyPath(label, key)} must be an own data property.`);
  }
  if (!('value' in descriptor)) {
    throw new TypeError(`${propertyPath(label, key)} must not be an accessor.`);
  }
  return descriptor.value as Source[Key];
}

export function readOptionalOwnDataProperty<Source extends object, Key extends keyof Source>(
  source: Source,
  key: Key,
  label: string,
): Source[Key] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new TypeError(`${propertyPath(label, key)} must not be an accessor.`);
  }
  return descriptor.value as Source[Key];
}

/**
 * Copies JSON-like authority data without invoking user-controlled accessors.
 * Symbols, exotic prototypes, functions, non-enumerable data and cycles are
 * rejected because none are part of Coral's persisted schemas.
 */
export function immutablePlainSnapshot<Value>(value: Value, label: string): Value {
  return snapshotValue(value, label, new WeakSet<object>()) as Value;
}

function snapshotValue(value: unknown, label: string, ancestors: WeakSet<object>): unknown {
  if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must contain only persisted plain data.`);
  }
  if (ancestors.has(value)) throw new TypeError(`${label} must not contain cycles.`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return snapshotArray(value, label, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must be a plain object.`);
    }

    const snapshot = Object.create(prototype) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol properties.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${propertyPath(label, key)} must be an enumerable data property.`);
      }
      Object.defineProperty(snapshot, key, {
        value: snapshotValue(descriptor.value, propertyPath(label, key), ancestors),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotArray(value: unknown[], label: string, ancestors: WeakSet<object>): readonly unknown[] {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor !== undefined && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${label}.length must be a safe non-negative integer data property.`);
  }

  const snapshot = new Array<unknown>(length);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol properties.`);
    if (key === 'length') continue;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
      throw new TypeError(`${propertyPath(label, key)} must be an array index.`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`${propertyPath(label, key)} must be an enumerable data property.`);
    }
    Object.defineProperty(snapshot, key, {
      value: snapshotValue(descriptor.value, `${label}[${key}]`, ancestors),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}
