import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerApplyError, ConsumerRegistrationKind } from './consumer-contract.js';
import type { StoreReadContext } from './body-codec.js';
import { getEventsSince } from './queries/events.js';
import { applyReducer, composeReducers, type ComposedReducers, type DomainEventRegistry } from './reducers.js';
import { createDefaultUpcasterRegistry } from './upcasters.js';

export interface ProjectionConsumerHandle {
  readonly id: string;
  readonly registrationKind: ConsumerRegistrationKind;
  readonly lastApplyError: ConsumerApplyError | null;
  stop(): Promise<void>;
  unregister(): Promise<void>;
}

export interface JournalApplyContext {
  readonly fromSeq: number;
  readonly upToSeq: number;
  readonly db: BetterSqlite3.Database;
}

export interface JournalConsumerRegistration {
  readonly id: string;
  readonly authority: 'journal';
  readonly registrationKind?: ConsumerRegistrationKind;
  readonly onApplyFailure?: (err: ConsumerApplyError) => void;
  apply(ctx: JournalApplyContext): Promise<void>;
}

export type JournalConsumerRegistrar = {
  register(reg: JournalConsumerRegistration): ProjectionConsumerHandle;
};

async function applyProjectionRange(
  db: BetterSqlite3.Database,
  reducers: ComposedReducers,
  eventTypes: ReadonlySet<string>,
  fromSeq: number,
  upToSeq: number,
  readCtx: StoreReadContext,
): Promise<void> {
  let cursor = fromSeq;

  while (cursor < upToSeq) {
    const page = getEventsSince(db, cursor, {}, 1_000, readCtx);
    const scoped = page.events.filter((event) => event.seq <= upToSeq && eventTypes.has(event.type));
    if (scoped.length > 0) {
      const txn = db.transaction(() => {
        for (const event of scoped) {
          applyReducer(db, event, reducers);
        }
      });
      txn.immediate();
    }

    if (page.nextCursor <= cursor) {
      break;
    }

    cursor = page.nextCursor;
  }
}

export function registerJournalProjectionConsumer(
  driver: JournalConsumerRegistrar,
  db: BetterSqlite3.Database,
  consumerId: string,
  registry: DomainEventRegistry,
): ProjectionConsumerHandle {
  const reducers = composeReducers(registry);
  const eventTypes = new Set(registry.types);
  const readCtx: StoreReadContext = {
    schemas: reducers.schemas,
    upcasters: createDefaultUpcasterRegistry(),
  };
  return driver.register({
    id: consumerId,
    authority: 'journal',
    apply: ({ fromSeq, upToSeq }) => applyProjectionRange(db, reducers, eventTypes, fromSeq, upToSeq, readCtx),
  });
}
