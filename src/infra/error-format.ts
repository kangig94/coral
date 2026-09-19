import { z } from 'zod';

import { isRecord } from './json.js';

export const SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH = 128;
export const SERIALIZED_THROWN_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]+$/u;

export const serializedThrownIdentifierSchema = z
  .string()
  .min(1)
  .max(SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH)
  .regex(SERIALIZED_THROWN_IDENTIFIER_PATTERN);

export const SERIALIZED_THROWN_CAUSE_MAX_DEPTH = 8;

type SerializedThrownWithCause<Cause> =
  | Readonly<{
      kind: 'error';
      name: string;
      code?: string;
      message: string;
      stack?: string;
      cause?: Cause;
    }>
  | Readonly<{ kind: 'unknown'; code?: string; message: string }>;

export type SerializedThrown =
  | Readonly<{
      kind: 'error';
      name: string;
      code?: string;
      message: string;
      stack?: string;
      cause?: SerializedThrown;
    }>
  | Readonly<{ kind: 'unknown'; code?: string; message: string }>;

const serializedThrownShape = () =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('error'),
      name: serializedThrownIdentifierSchema,
      code: serializedThrownIdentifierSchema.optional(),
      message: z.string(),
      stack: z.string().optional(),
      cause: serializedThrownSchema.optional(),
    }),
    z.object({
      kind: z.literal('unknown'),
      code: serializedThrownIdentifierSchema.optional(),
      message: z.string(),
    }),
  ]);

export const serializedThrownSchema: z.ZodType<SerializedThrown> = z.lazy(serializedThrownShape);

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type DeepRequired<T> = T extends Primitive
  ? T
  : T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepRequired<Item>[]
      : { [K in keyof T]-?: DeepRequired<T[K]> };

type SerializedThrownSchemaShape = z.infer<ReturnType<typeof serializedThrownShape>>;
// Constraint: `DeepRequired` catches nested divergence but erases optional modifiers. Measured with
// `tsc -p tsconfig/typecheck.json`: making `serializedThrownShape`'s `unknown.code` required while
// `SerializedThrown` kept it optional left the deep pair and `z.ZodType<SerializedThrown>` green; the bare
// pair failed with `code: string` against `code?: string`. Both pairs must remain so depth and optionality are
// checked independently.
const _serializedThrownTypeFitsSchema: DeepRequired<SerializedThrownSchemaShape> = {} as DeepRequired<SerializedThrown>;
const _serializedThrownSchemaFitsType: DeepRequired<SerializedThrown> = {} as DeepRequired<SerializedThrownSchemaShape>;
const _serializedThrownTypeOptionalityFitsSchema: SerializedThrownSchemaShape = {} as SerializedThrown;
const _serializedThrownSchemaOptionalityFitsType: SerializedThrown = {} as SerializedThrownSchemaShape;

type SerializeCause<Cause> = (error: unknown, causeDepth: number) => Cause;

/**
 * The `.code` a thrown value carries, wherever it was put — a Node system errno such as `ECONNREFUSED`, or a
 * string code from a non-Node layer in the same throw chain such as undici's `UND_ERR_SOCKET`.
 *
 * `fetch` rejects with a `TypeError('fetch failed')` and hangs the code off `.cause`, so a reader that looks
 * only at the top level sees nothing. An `AbortSignal.timeout` instead rejects with a `DOMException` whose
 * `.code` is the *number* `23`, so the string check is not decoration: without it that number reaches an
 * operator as the detail of a sentence about their coordinator.
 */
export function thrownErrnoCode(error: unknown): string | undefined {
  return errnoCode(error instanceof Error ? error.cause : undefined) ?? errnoCode(error);
}

function errnoCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined;
}

function canonicalThrownIdentifier(value: string, fallback: string): string {
  const identifier = [...value]
    .map((character) => (SERIALIZED_THROWN_IDENTIFIER_PATTERN.test(character) ? character : '_'))
    .join('')
    .replace(/_+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, SERIALIZED_THROWN_IDENTIFIER_MAX_LENGTH);
  return identifier.length === 0 ? fallback : identifier;
}

export function serializeThrown(error: unknown, causeDepth?: number): SerializedThrown;
export function serializeThrown<Cause>(
  error: unknown,
  causeDepth: number,
  serializeCause: SerializeCause<Cause>,
): SerializedThrownWithCause<Cause>;
export function serializeThrown<Cause>(
  error: unknown,
  causeDepth = 0,
  serializeCause: SerializeCause<Cause | SerializedThrown> = serializeThrown,
): SerializedThrownWithCause<Cause | SerializedThrown> {
  const code = errnoCode(error);
  const canonicalCode = code === undefined ? undefined : canonicalThrownIdentifier(code, 'UnknownCode');
  if (error instanceof Error) {
    const nestedCause = error.cause;
    return {
      kind: 'error',
      name: canonicalThrownIdentifier(error.name, 'Error'),
      ...(canonicalCode === undefined ? {} : { code: canonicalCode }),
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(nestedCause === undefined || nestedCause === null || causeDepth >= SERIALIZED_THROWN_CAUSE_MAX_DEPTH
        ? {}
        : { cause: serializeCause(nestedCause, causeDepth + 1) }),
    };
  }
  return {
    kind: 'unknown',
    ...(canonicalCode === undefined ? {} : { code: canonicalCode }),
    message: String(error),
  };
}

export function formatError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
