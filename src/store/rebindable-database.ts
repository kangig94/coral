import type { Database, Statement } from './db.js';

export type RebindableStoreDatabase = Readonly<{
  db: Database;
  closeCurrent(): void;
  replace(db: Database): void;
}>;

export function createRebindableStoreDatabase(initial: Database): RebindableStoreDatabase {
  let current: Database | null = initial;
  let revision = 0;
  const db = new Proxy({} as Database, {
    get(_target, property) {
      if (current === null) throw new Error('Store database is parked.');
      if (property === 'prepare') {
        return <TParams extends unknown[] = unknown[], TRow = unknown>(sql: string): Statement<TParams, TRow> => {
          let statement: Statement<TParams, TRow> | null = null;
          let statementRevision = -1;
          return new Proxy({} as Statement<TParams, TRow>, {
            get(_statementTarget, statementProperty) {
              if (current === null) throw new Error('Store database is parked.');
              if (statementRevision !== revision) {
                statement = current.prepare<TParams, TRow>(sql);
                statementRevision = revision;
              }
              const active = statement!;
              const value: unknown = Reflect.get(active, statementProperty, active);
              return typeof value === 'function' ? value.bind(active) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(current, property, current);
      return typeof value === 'function' ? value.bind(current) : value;
    },
  });
  return {
    db,
    closeCurrent() {
      const closing = current;
      current = null;
      closing?.close();
    },
    replace(next) {
      if (current !== null) throw new Error('Store database must be parked before rebinding.');
      current = next;
      revision += 1;
    },
  };
}
