import type { Database, Statement } from '../store/db.js';
import type { RecoveryObservation } from './phase-observation.js';

export function observeDatabaseReads(db: Database, observation: RecoveryObservation, source: string): Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return <Params extends unknown[], Row>(sql: string): Statement<Params, Row> => {
          const statement = target.prepare<Params, Row>(sql);
          return new Proxy(statement, {
            get(prepared, method) {
              if (method === 'get')
                return (...params: Params) => {
                  const row = prepared.get(...params);
                  observation.record(source, { reads: row === undefined ? 0 : 1 });
                  return row;
                };
              if (method === 'all')
                return (...params: Params) => {
                  const rows = prepared.all(...params);
                  observation.record(source, { reads: rows.length });
                  return rows;
                };
              if (method === 'iterate')
                return function* (...params: Params) {
                  for (const row of prepared.iterate(...params)) {
                    observation.record(source, { reads: 1 });
                    yield row;
                  }
                };
              const value: unknown = Reflect.get(prepared, method, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
