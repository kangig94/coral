import type BetterSqlite3 from 'better-sqlite3';
import { type z } from 'zod';

import type { CoralEvent } from './envelope.js';
import { CoralSetupError } from '../runtime/errors.js';

type Database = BetterSqlite3.Database;

export type Reducer<T = unknown> = (db: Database, event: CoralEvent<T>) => void;

export interface DomainEventRegistry {
  readonly types: readonly string[];
  readonly reducers: Record<string, Reducer<unknown>>;
  readonly schemas: Record<string, z.ZodType>;
}

export interface ComposedReducers {
  readonly types: readonly string[];
  readonly reducers: Map<string, Reducer<unknown>>;
  readonly schemas: Map<string, z.ZodType>;
}

export function composeReducers(...registries: DomainEventRegistry[]): ComposedReducers {
  const reducers = new Map<string, Reducer<unknown>>();
  const schemas = new Map<string, z.ZodType>();
  const types: string[] = [];

  for (const registry of registries) {
    for (const type of registry.types) {
      if (reducers.has(type)) {
        throw new CoralSetupError({
          code: 'reducer_duplicate',
          userMessage: `Reducer for type '${type}' registered twice`,
          remediation: 'Each event type must have exactly one registered reducer across all DomainEventRegistries.',
          context: { type },
        });
      }

      if (!registry.schemas[type]) {
        throw new CoralSetupError({
          code: 'schema_missing_for_event_type',
          userMessage: `Schema for type '${type}' is missing`,
          remediation: 'Each event type declared in registry.types must register a matching schema before startup.',
          context: { type },
        });
      }

      if (registry.reducers[type]) {
        reducers.set(type, registry.reducers[type]);
      }

      schemas.set(type, registry.schemas[type]);

      types.push(type);
    }
  }

  return { types, reducers, schemas };
}

export function applyReducer(db: Database, event: CoralEvent, reducers: ComposedReducers): void {
  const reducer = reducers.reducers.get(event.type);
  if (!reducer) return;
  reducer(db, event);
}
