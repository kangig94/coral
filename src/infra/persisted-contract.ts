import { z } from 'zod';

/**
 * Pure: zod in, plain data out, no I/O and no store access of any kind. It lives here rather than under
 * `store/` because `providers/` depends on it to declare each provider's persisted-codec contract, and a
 * provider reaching into `store/` for a pure transform is a dependency that reads as store access without
 * being any. The
 * provider-proxy roles must never touch `store/` at all (W2.8), and that ban is enforced by import
 * reachability, so a pure helper sitting under the banned path is indistinguishable from the real thing.
 *
 * The fingerprint this feeds is a durable identity, so every ordering rule here is load-bearing: two copies
 * of `compareText` that drifted would change the fingerprint and quarantine every existing store.
 */

export type CanonicalContractValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalContractValue[]
  | { readonly [key: string]: CanonicalContractValue };
type ZodDefinition = Readonly<Record<string, unknown>> & { readonly typeName?: unknown };

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeContractValue(value: unknown, path: string): CanonicalContractValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path} cannot be part of a persisted contract.`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }
  if (value === undefined) {
    return { $undefined: true };
  }
  if (value instanceof RegExp) {
    return { $regexp: value.source, flags: value.flags };
  }
  if (value instanceof Date) {
    return { $date: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalizeContractValue(entry, `${path}[${index}]`));
  }
  if (value instanceof Set) {
    const entries = [...value].map((entry, index) => canonicalizeContractValue(entry, `${path}.set[${index}]`));
    return {
      $set: entries.sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right))),
    };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([key, entry], index) =>
        [
          canonicalizeContractValue(key, `${path}.map[${index}].key`),
          canonicalizeContractValue(entry, `${path}.map[${index}].value`),
        ] as const,
    );
    entries.sort((left, right) => compareText(JSON.stringify(left[0]), JSON.stringify(right[0])));
    return { $map: entries };
  }
  if (!isPlainRecord(value)) {
    throw new TypeError(`Unsupported persisted contract value at ${path}: ${Object.prototype.toString.call(value)}`);
  }

  const result: Record<string, CanonicalContractValue> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    result[key] = canonicalizeContractValue(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalContractJson(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value, '$'));
}

function definitionOf(schema: z.ZodTypeAny): ZodDefinition {
  return (schema as unknown as { readonly _def: ZodDefinition })._def;
}

function requiredDefinitionField(definition: ZodDefinition, key: string, typeName: string): unknown {
  if (!(key in definition)) {
    throw new TypeError(`Zod contract ${typeName} is missing definition field '${key}'.`);
  }
  return definition[key];
}

function schemaField(definition: ZodDefinition, key: string, typeName: string): z.ZodTypeAny {
  const value = requiredDefinitionField(definition, key, typeName);
  if (!(value instanceof z.ZodType)) {
    throw new TypeError(`Zod contract ${typeName}.${key} is not a schema.`);
  }
  return value;
}

function schemaArrayField(definition: ZodDefinition, key: string, typeName: string): readonly z.ZodTypeAny[] {
  const value = requiredDefinitionField(definition, key, typeName);
  if (!Array.isArray(value) || value.some((entry) => !(entry instanceof z.ZodType))) {
    throw new TypeError(`Zod contract ${typeName}.${key} is not a schema array.`);
  }
  return value as readonly z.ZodTypeAny[];
}

function lengthConstraint(value: unknown): CanonicalContractValue {
  return canonicalizeContractValue(value, '$.length');
}

function checks(definition: ZodDefinition): CanonicalContractValue {
  return canonicalizeContractValue(definition.checks ?? [], '$.checks');
}

function semanticEffectIdentity(definition: ZodDefinition, typeName: string): string {
  const description = definition.description;
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new TypeError(
      `${typeName} in a persisted contract requires a stable semantic identity via schema.describe(...).`,
    );
  }
  return description;
}

type ZodContractBase = {
  readonly $id: number;
  readonly type: z.ZodFirstPartyTypeKind;
};

type ZodContractVisitor = (schema: z.ZodTypeAny) => CanonicalContractValue;

function structuralZodContract(
  typeName: z.ZodFirstPartyTypeKind,
  definition: ZodDefinition,
  base: ZodContractBase,
  visit: ZodContractVisitor,
): CanonicalContractValue | undefined {
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodArray:
      return {
        ...base,
        element: visit(schemaField(definition, 'type', typeName)),
        exactLength: lengthConstraint(definition.exactLength),
        minLength: lengthConstraint(definition.minLength),
        maxLength: lengthConstraint(definition.maxLength),
      };
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shapeFactory = requiredDefinitionField(definition, 'shape', typeName);
      if (typeof shapeFactory !== 'function') throw new TypeError('ZodObject shape is not callable.');
      const shape = (shapeFactory as () => unknown)();
      if (!isPlainRecord(shape)) throw new TypeError('ZodObject shape did not return a record.');
      const fields: Record<string, CanonicalContractValue> = {};
      for (const key of Object.keys(shape).sort(compareText)) {
        const field = shape[key];
        if (!(field instanceof z.ZodType)) throw new TypeError(`ZodObject field '${key}' is not a schema.`);
        fields[key] = visit(field);
      }
      return {
        ...base,
        fields,
        unknownKeys: canonicalizeContractValue(definition.unknownKeys, '$.unknownKeys'),
        catchall: visit(schemaField(definition, 'catchall', typeName)),
      };
    }
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return { ...base, options: schemaArrayField(definition, 'options', typeName).map(visit) };
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return {
        ...base,
        discriminator: canonicalizeContractValue(definition.discriminator, '$.discriminator'),
        options: schemaArrayField(definition, 'options', typeName).map(visit),
      };
    case z.ZodFirstPartyTypeKind.ZodIntersection:
      return {
        ...base,
        left: visit(schemaField(definition, 'left', typeName)),
        right: visit(schemaField(definition, 'right', typeName)),
      };
    case z.ZodFirstPartyTypeKind.ZodTuple:
      return {
        ...base,
        items: schemaArrayField(definition, 'items', typeName).map(visit),
        rest:
          definition.rest instanceof z.ZodType
            ? visit(definition.rest)
            : canonicalizeContractValue(definition.rest, '$.rest'),
      };
    case z.ZodFirstPartyTypeKind.ZodRecord:
    case z.ZodFirstPartyTypeKind.ZodMap:
      return {
        ...base,
        key: visit(schemaField(definition, 'keyType', typeName)),
        value: visit(schemaField(definition, 'valueType', typeName)),
      };
    case z.ZodFirstPartyTypeKind.ZodSet:
      return {
        ...base,
        value: visit(schemaField(definition, 'valueType', typeName)),
        minSize: lengthConstraint(definition.minSize),
        maxSize: lengthConstraint(definition.maxSize),
      };
    case z.ZodFirstPartyTypeKind.ZodFunction:
      return {
        ...base,
        args: visit(schemaField(definition, 'args', typeName)),
        returns: visit(schemaField(definition, 'returns', typeName)),
      };
    case z.ZodFirstPartyTypeKind.ZodLazy: {
      const getter = requiredDefinitionField(definition, 'getter', typeName);
      if (typeof getter !== 'function') throw new TypeError('ZodLazy getter is not callable.');
      const target = (getter as () => unknown)();
      if (!(target instanceof z.ZodType)) throw new TypeError('ZodLazy getter did not return a schema.');
      return { ...base, value: visit(target) };
    }
    default:
      return undefined;
  }
}

function wrappedZodContract(
  typeName: z.ZodFirstPartyTypeKind,
  definition: ZodDefinition,
  base: ZodContractBase,
  visit: ZodContractVisitor,
): CanonicalContractValue | undefined {
  switch (typeName) {
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { ...base, value: canonicalizeContractValue(definition.value, '$.literal') };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { ...base, values: canonicalizeContractValue(definition.values, '$.enum') };
    case z.ZodFirstPartyTypeKind.ZodNativeEnum:
      return { ...base, values: canonicalizeContractValue(definition.values, '$.nativeEnum') };
    case z.ZodFirstPartyTypeKind.ZodEffects: {
      const effect = definition.effect;
      if (!isPlainRecord(effect) || typeof effect.type !== 'string') {
        throw new TypeError('ZodEffects effect has no stable type.');
      }
      return {
        ...base,
        input: visit(schemaField(definition, 'schema', typeName)),
        effect: effect.type,
        semanticIdentity: semanticEffectIdentity(definition, typeName),
      };
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodReadonly:
      return { ...base, inner: visit(schemaField(definition, 'innerType', typeName)) };
    case z.ZodFirstPartyTypeKind.ZodPromise:
    case z.ZodFirstPartyTypeKind.ZodBranded:
      return { ...base, inner: visit(schemaField(definition, 'type', typeName)) };
    case z.ZodFirstPartyTypeKind.ZodDefault: {
      const defaultValue = requiredDefinitionField(definition, 'defaultValue', typeName);
      if (typeof defaultValue !== 'function') throw new TypeError('ZodDefault defaultValue is not callable.');
      return {
        ...base,
        inner: visit(schemaField(definition, 'innerType', typeName)),
        default: canonicalizeContractValue((defaultValue as () => unknown)(), '$.default'),
      };
    }
    case z.ZodFirstPartyTypeKind.ZodCatch:
      return {
        ...base,
        inner: visit(schemaField(definition, 'innerType', typeName)),
        catch: semanticEffectIdentity(definition, typeName),
      };
    case z.ZodFirstPartyTypeKind.ZodPipeline:
      return {
        ...base,
        input: visit(schemaField(definition, 'in', typeName)),
        output: visit(schemaField(definition, 'out', typeName)),
      };
    default:
      return undefined;
  }
}

/**
 * Runtime callbacks are represented by their effect kind plus an explicit semantic identity,
 * never by Function#toString(): the shipped backend is minified, so executable
 * source text is not a stable serialization identity.
 */
export function zodPersistedContract(schema: z.ZodTypeAny): CanonicalContractValue {
  const seen = new Map<z.ZodTypeAny, number>();

  const visit = (current: z.ZodTypeAny): CanonicalContractValue => {
    const existing = seen.get(current);
    if (existing !== undefined) {
      return { $ref: existing };
    }
    const id = seen.size;
    seen.set(current, id);

    const definition = definitionOf(current);
    const rawTypeName = definition.typeName;
    if (typeof rawTypeName !== 'string') {
      throw new TypeError('Zod persisted contract has no typeName.');
    }
    const typeName = rawTypeName as z.ZodFirstPartyTypeKind;

    const base = { $id: id, type: typeName };
    switch (typeName) {
      case z.ZodFirstPartyTypeKind.ZodString:
      case z.ZodFirstPartyTypeKind.ZodNumber:
      case z.ZodFirstPartyTypeKind.ZodBigInt:
      case z.ZodFirstPartyTypeKind.ZodDate:
        return {
          ...base,
          coerce: definition.coerce === true,
          checks: checks(definition),
        };
      case z.ZodFirstPartyTypeKind.ZodNaN:
      case z.ZodFirstPartyTypeKind.ZodBoolean:
      case z.ZodFirstPartyTypeKind.ZodSymbol:
      case z.ZodFirstPartyTypeKind.ZodUndefined:
      case z.ZodFirstPartyTypeKind.ZodNull:
      case z.ZodFirstPartyTypeKind.ZodAny:
      case z.ZodFirstPartyTypeKind.ZodUnknown:
      case z.ZodFirstPartyTypeKind.ZodNever:
      case z.ZodFirstPartyTypeKind.ZodVoid:
        return definition.coerce === undefined ? base : { ...base, coerce: definition.coerce === true };
      default: {
        const structural = structuralZodContract(typeName, definition, base, visit);
        if (structural !== undefined) return structural;
        const wrapped = wrappedZodContract(typeName, definition, base, visit);
        if (wrapped !== undefined) return wrapped;
        throw new TypeError(`Unsupported Zod persisted contract type '${typeName}'.`);
      }
    }
  };

  return canonicalizeContractValue(visit(schema), '$.zod');
}
