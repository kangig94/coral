import type { Database } from './db.js';
import { type z } from 'zod';

import type { CoralEvent, CoralEventInput, StreamKind } from './envelope.js';
import { CoralSetupError } from '../runtime/errors.js';
import type { ProviderLookupPort } from '../providers/catalog.js';
import type { StoreReadContext } from './body-codec.js';

export type Reducer<T = unknown> = (db: Database, event: CoralEvent<T>) => void;
export interface DomainAppendValidationContext {
  readonly db: Database;
  readonly providers: ProviderLookupPort;
  readonly readCtx: StoreReadContext;
}

export type DomainAppendValidator = (ctx: DomainAppendValidationContext, inputs: readonly CoralEventInput[]) => void;

export interface DomainAppendValidatorEntry {
  /** Stable semantic identity included in the active store fingerprint. */
  readonly contract: string;
  readonly validate: DomainAppendValidator;
}

/**
 * A single event-type entry: type tag, body schema, and an optional reducer.
 * Use {@link defineDomainEvent} so TypeScript infers the body shape from the
 * schema and verifies the reducer matches; the registry stores entries with
 * the body type erased to `unknown`.
 */
interface DomainEventEntryBase {
  readonly type: string;
  readonly schema: z.ZodType;
}

export type DomainEventEntry = DomainEventEntryBase &
  (
    | {
        readonly reducer: Reducer<unknown>;
        /** Stable materialization identity required whenever a reducer is present. */
        readonly materializerContract: string;
      }
    | {
        readonly reducer?: undefined;
        readonly materializerContract?: undefined;
      }
  );

export interface DomainEventRegistry {
  readonly streamKind: StreamKind;
  readonly entries: readonly DomainEventEntry[];
  readonly appendValidators?: readonly DomainAppendValidatorEntry[];
}

/**
 * Type-safe entry constructor. The reducer's body parameter is inferred from
 * the schema's parsed (output) type, so `.default()`-style fields surface as
 * required values to the reducer. The single `as` cast lives here so domain
 * code never carries `as Reducer<unknown>` noise.
 */
export function defineDomainEvent<S extends z.ZodTypeAny>(entry: {
  type: string;
  schema: S;
  reducer?: Reducer<z.output<S>>;
  materializerContract?: string;
}): DomainEventEntry {
  if ((entry.reducer === undefined) !== (entry.materializerContract === undefined)) {
    throw new TypeError(
      `Domain event '${entry.type}' must declare materializerContract exactly when it declares a reducer.`,
    );
  }
  if (entry.materializerContract !== undefined && entry.materializerContract.trim().length === 0) {
    throw new TypeError(`Domain event '${entry.type}' has an empty materializerContract.`);
  }
  return entry as DomainEventEntry;
}

export interface ComposedReducers {
  readonly types: readonly string[];
  readonly reducers: Map<string, Reducer<unknown>>;
  readonly materializerContracts: ReadonlyMap<string, string>;
  readonly schemas: Map<string, z.ZodType>;
  /** Canonical stream kind for each registered event type. */
  readonly streamKinds: ReadonlyMap<string, StreamKind>;
  readonly appendValidators: readonly DomainAppendValidator[];
  readonly appendValidatorContracts: readonly string[];
  /**
   * Describer-key form (`${streamKind}:${type}`) for every registered event
   * type. Used to assert describer parity at startup and in invariants.
   */
  readonly describerKeys: readonly string[];
}

export function composeReducers(...registries: DomainEventRegistry[]): ComposedReducers {
  const reducers = new Map<string, Reducer<unknown>>();
  const materializerContracts = new Map<string, string>();
  const schemas = new Map<string, z.ZodType>();
  const streamKinds = new Map<string, StreamKind>();
  const types: string[] = [];
  const describerKeys: string[] = [];
  const appendValidators: DomainAppendValidator[] = [];
  const appendValidatorContracts: string[] = [];

  for (const registry of registries) {
    for (const validator of registry.appendValidators ?? []) {
      if (validator.contract.trim().length === 0) {
        throw new TypeError('Domain append validator has an empty persisted contract identity.');
      }
      if (appendValidatorContracts.includes(validator.contract)) {
        throw new TypeError(`Domain append validator contract '${validator.contract}' is registered twice.`);
      }
      appendValidators.push(validator.validate);
      appendValidatorContracts.push(validator.contract);
    }

    for (const entry of registry.entries) {
      if (schemas.has(entry.type)) {
        throw new CoralSetupError({
          code: 'reducer_duplicate',
          userMessage: `Reducer for type '${entry.type}' registered twice`,
          remediation: 'Each event type must have exactly one entry across all DomainEventRegistries.',
          context: { type: entry.type },
        });
      }

      if (entry.reducer) {
        reducers.set(entry.type, entry.reducer);
        materializerContracts.set(entry.type, entry.materializerContract);
      }
      schemas.set(entry.type, entry.schema);
      streamKinds.set(entry.type, registry.streamKind);
      types.push(entry.type);
      describerKeys.push(`${registry.streamKind}:${entry.type}`);
    }
  }

  return {
    types,
    reducers,
    materializerContracts,
    schemas,
    streamKinds,
    appendValidators,
    appendValidatorContracts,
    describerKeys,
  };
}

export function assertRegisteredEventStream(
  event: Pick<CoralEvent, 'type' | 'stream'>,
  reducers: ComposedReducers,
): void {
  const expected = reducers.streamKinds.get(event.type);
  if (expected === undefined || event.stream.kind === expected) return;

  throw new CoralSetupError({
    code: 'event_stream_kind_mismatch',
    userMessage: `Event '${event.type}' belongs to the '${expected}' stream, not '${event.stream.kind}'.`,
    remediation: `Append '${event.type}' with stream.kind='${expected}'.`,
    context: {
      type: event.type,
      expectedStreamKind: expected,
      actualStreamKind: event.stream.kind,
      streamId: event.stream.id,
    },
  });
}

/**
 * Dispatch a journal event to its registered reducer. The event's body is
 * already schema-parsed by the upstream caller — reducers can rely on the
 * body shape matching its registered schema without re-parsing.
 */
export function applyReducer(db: Database, event: CoralEvent, reducers: ComposedReducers): void {
  assertRegisteredEventStream(event, reducers);
  const reducer = reducers.reducers.get(event.type);
  if (!reducer) {
    return;
  }
  reducer(db, event);
}
