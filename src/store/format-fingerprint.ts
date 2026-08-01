import { z } from 'zod';

import { sha256Hex } from '../infra/hash.js';

export type CanonicalContractValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalContractValue[]
  | { readonly [key: string]: CanonicalContractValue };

export type PersistedCodecManifestEntry = {
  readonly name: string;
  readonly persistence: 'boundary' | 'component';
  readonly contract: CanonicalContractValue;
};

export type PersistedDdlFragment = {
  readonly name: string;
  readonly ddl: string;
};

export type StoreFormatManifest = {
  readonly kind: 'coral-store-format';
  readonly ddl: string;
  readonly codecs: readonly PersistedCodecManifestEntry[];
};

export type StoreFormatFingerprintDescription = {
  readonly manifest: StoreFormatManifest;
  readonly canonicalManifest: string;
  readonly fingerprint: StoreFormatFingerprint;
};

export type StoreFormatDescription = StoreFormatFingerprintDescription & {
  readonly productVersion: string;
};

export type StoreFormatFingerprint = `sha256:${string}`;

type CurrentStoreFormatIdentity = {
  readonly currentFingerprint: StoreFormatFingerprint;
  readonly currentProductVersion: string;
};

type StoredStoreFormatIdentity = CurrentStoreFormatIdentity & {
  readonly storedFingerprint: StoreFormatFingerprint;
  readonly storedProductVersion: string;
};

/**
 * Classification of an on-disk store against the current executable contract:
 * `absent` has no database file; `fresh` has no user tables; `compatible` has
 * the current fingerprint and a valid non-newer version; `legacy-adoptable`
 * has the current fingerprint but no product-version row; `older-incompatible`
 * and `newer-incompatible` have valid versions on the corresponding side of
 * current SemVer precedence; `corrupt-or-unsupported` covers missing, malformed,
 * or equal-version/different-fingerprint metadata that cannot be ordered safely.
 */
export type StoreFormatClassification =
  | { readonly kind: 'absent' }
  | { readonly kind: 'fresh' }
  | (StoredStoreFormatIdentity & { readonly kind: 'compatible' })
  | (CurrentStoreFormatIdentity & {
      readonly kind: 'legacy-adoptable';
      readonly storedFingerprint: StoreFormatFingerprint;
    })
  | (StoredStoreFormatIdentity & { readonly kind: 'older-incompatible' })
  | (StoredStoreFormatIdentity & { readonly kind: 'newer-incompatible' })
  | (CurrentStoreFormatIdentity & {
      readonly kind: 'corrupt-or-unsupported';
      readonly storedFingerprint: string | null;
      readonly storedProductVersion: string | null;
    });

export const STORE_FORMAT_FINGERPRINT_META_KEY = 'store_format_fingerprint';
export const STORE_PRODUCT_VERSION_META_KEY = 'store_product_version';

const STORE_FORMAT_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isStoreFormatFingerprint(value: unknown): value is StoreFormatFingerprint {
  return typeof value === 'string' && STORE_FORMAT_FINGERPRINT_PATTERN.test(value);
}

const CODEC_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PERSISTED_CODEC_ANNOTATION = /@persisted-codec\s+([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*)/g;
const JSON_BOUNDARY_COMMENT = /--[^\r\n]*\bJSON\b/i;

type ZodDefinition = Readonly<Record<string, unknown>> & { readonly typeName?: unknown };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeContractValue(value: unknown, path: string): CanonicalContractValue {
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
 * Convert a Zod decoder into a stable persisted contract. Runtime callbacks
 * are represented by their effect kind plus an explicit semantic identity,
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

export class PersistedCodecRegistry {
  readonly #entries = new Map<string, Omit<PersistedCodecManifestEntry, 'name'>>();

  register(
    name: string,
    contract: unknown,
    persistence: PersistedCodecManifestEntry['persistence'] = 'boundary',
  ): void {
    if (!CODEC_NAME.test(name)) {
      throw new TypeError(`Invalid persisted codec name '${name}'.`);
    }
    if (this.#entries.has(name)) {
      throw new Error(`Persisted codec '${name}' is registered twice.`);
    }
    this.#entries.set(name, { persistence, contract: canonicalizeContractValue(contract, `$.codecs.${name}`) });
  }

  registerZod(name: string, schema: z.ZodTypeAny): void {
    this.register(name, zodPersistedContract(schema));
  }

  registerZodComponent(name: string, schema: z.ZodTypeAny): void {
    this.register(name, zodPersistedContract(schema), 'component');
  }

  entries(): readonly PersistedCodecManifestEntry[] {
    return [...this.#entries.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, entry]) => Object.freeze({ name, ...entry }));
  }
}

export function persistedCodecNamesFromDdl(ddl: string): readonly string[] {
  for (const [index, line] of ddl.split(/\r?\n/u).entries()) {
    const declaresJson = JSON_BOUNDARY_COMMENT.test(line);
    const declaresCodec = new RegExp(PERSISTED_CODEC_ANNOTATION.source, 'u').test(line);
    if (declaresJson && !declaresCodec) {
      throw new Error(`DDL JSON boundary on line ${index + 1} has no @persisted-codec declaration.`);
    }
    if (declaresCodec && !declaresJson) {
      throw new Error(`DDL persisted codec on line ${index + 1} is not declared as a JSON boundary.`);
    }
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of ddl.matchAll(PERSISTED_CODEC_ANNOTATION)) {
    const name = match[1];
    if (name === undefined) continue;
    if (seen.has(name)) {
      throw new Error(`DDL declares persisted codec '${name}' more than once.`);
    }
    seen.add(name);
    names.push(name);
  }
  return names.sort(compareText);
}

function assertCodecCoverage(ddl: string, entries: readonly PersistedCodecManifestEntry[]): void {
  const declared = persistedCodecNamesFromDdl(ddl);
  const registered = entries.filter((entry) => entry.persistence === 'boundary').map((entry) => entry.name);
  const missing = declared.filter((name) => !registered.includes(name));
  const orphaned = registered.filter((name) => !declared.includes(name));
  if (missing.length === 0 && orphaned.length === 0) return;
  throw new Error(
    `Persisted codec coverage mismatch: missing=[${missing.join(', ')}] orphaned=[${orphaned.join(', ')}]`,
  );
}

function canonicalDdl(ddl: string): string {
  return `${ddl.replaceAll('\r\n', '\n').trimEnd()}\n`;
}

function completeDdl(primaryDdl: string, fragments: readonly PersistedDdlFragment[]): string {
  const seen = new Set<string>();
  const normalizedFragments = [...fragments]
    .map((fragment) => {
      if (!CODEC_NAME.test(fragment.name)) {
        throw new TypeError(`Invalid persisted DDL fragment name '${fragment.name}'.`);
      }
      if (seen.has(fragment.name)) {
        throw new Error(`Persisted DDL fragment '${fragment.name}' is registered twice.`);
      }
      seen.add(fragment.name);
      return fragment;
    })
    .sort((left, right) => compareText(left.name, right.name));

  return canonicalDdl(
    [primaryDdl, ...normalizedFragments.map(({ name, ddl }) => `-- @persisted-ddl ${name}\n${ddl}`)].join('\n'),
  );
}

export function describeStoreFormat(
  ddl: string,
  codecs: PersistedCodecRegistry,
  ddlFragments: readonly PersistedDdlFragment[] = [],
): StoreFormatFingerprintDescription {
  const entries = codecs.entries();
  const completeStoreDdl = completeDdl(ddl, ddlFragments);
  assertCodecCoverage(completeStoreDdl, entries);
  const manifest: StoreFormatManifest = Object.freeze({
    kind: 'coral-store-format',
    ddl: completeStoreDdl,
    codecs: entries,
  });
  const canonicalManifest = canonicalContractJson(manifest);
  return Object.freeze({
    manifest,
    canonicalManifest,
    fingerprint: `sha256:${sha256Hex(canonicalManifest)}`,
  });
}
