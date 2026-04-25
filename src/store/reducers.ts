import type BetterSqlite3 from 'better-sqlite3';
import { type z } from 'zod';

import type { CoralEvent, CoralEventInput } from './envelope.js';
import { CoralSetupError } from '../runtime/errors.js';

type Database = BetterSqlite3.Database;

export type Reducer<T = unknown> = (db: Database, event: CoralEvent<T>) => void;
export type DomainAppendValidator = (db: Database, inputs: readonly CoralEventInput[]) => void;

/**
 * A single event-type entry: type tag, body schema, and an optional reducer.
 * Use {@link defineDomainEvent} so TypeScript infers the body shape from the
 * schema and verifies the reducer matches; the registry stores entries with
 * the body type erased to `unknown`.
 */
export interface DomainEventEntry {
  readonly type: string;
  readonly schema: z.ZodType;
  readonly reducer?: Reducer<unknown>;
}

export interface DomainEventRegistry {
  readonly entries: readonly DomainEventEntry[];
  readonly appendValidators?: readonly DomainAppendValidator[];
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
}): DomainEventEntry {
  return entry as DomainEventEntry;
}

export interface ComposedReducers {
  readonly types: readonly string[];
  readonly reducers: Map<string, Reducer<unknown>>;
  readonly schemas: Map<string, z.ZodType>;
  readonly appendValidators: readonly DomainAppendValidator[];
}

export function composeReducers(...registries: DomainEventRegistry[]): ComposedReducers {
  const reducers = new Map<string, Reducer<unknown>>();
  const schemas = new Map<string, z.ZodType>();
  const types: string[] = [];
  const appendValidators: DomainAppendValidator[] = [];

  for (const registry of registries) {
    appendValidators.push(...(registry.appendValidators ?? []));

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
      }
      schemas.set(entry.type, entry.schema);
      types.push(entry.type);
    }
  }

  return { types, reducers, schemas, appendValidators };
}

/**
 * Dispatch a journal event to its registered reducer. The event's body is
 * already schema-parsed by the upstream caller (append, rebuild, or projection
 * consumer) — reducers can rely on the body shape matching its registered
 * schema without re-parsing.
 */
export function applyReducer(db: Database, event: CoralEvent, reducers: ComposedReducers): void {
  const reducer = reducers.reducers.get(event.type);
  if (!reducer) return;
  reducer(db, event);
}
