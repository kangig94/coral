import type { Database } from 'better-sqlite3';

const SQL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ProjectionUpsertOptions = {
  table: string;
  pkColumn: string;
  pkValue: unknown;
  columns: Record<string, unknown>;
  lastSeq: number;
};

function assertSqlIdentifier(identifier: string, label: string): string {
  if (!SQL_IDENTIFIER_RE.test(identifier)) {
    throw new TypeError(`Invalid SQL ${label}: ${identifier}`);
  }

  return identifier;
}

export function upsertProjection(db: Database, { table, pkColumn, pkValue, columns, lastSeq }: ProjectionUpsertOptions): void {
  const safeTable = assertSqlIdentifier(table, 'table identifier');
  const safePkColumn = assertSqlIdentifier(pkColumn, 'primary key column identifier');
  const columnEntries = Object.entries(columns)
    .map(([column, value]) => [assertSqlIdentifier(column, 'column identifier'), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const columnKeys = columnEntries.map(([column]) => column);

  if (columnKeys.includes(safePkColumn) || columnKeys.includes('last_seq')) {
    throw new TypeError('Projection upsert columns must not include the primary key or last_seq');
  }

  const insertColumns = [safePkColumn, ...columnKeys, 'last_seq'];
  const values = [pkValue, ...columnEntries.map(([, value]) => value), lastSeq];
  const setClauses =
    columnKeys.length === 0
      ? 'last_seq = excluded.last_seq'
      : `${columnKeys.map((column) => `${column} = excluded.${column}`).join(', ')}, last_seq = excluded.last_seq`;

  db.prepare(
    `INSERT INTO ${safeTable} (${insertColumns.join(', ')})
     VALUES (${insertColumns.map(() => '?').join(', ')})
     ON CONFLICT(${safePkColumn}) DO UPDATE SET
       ${setClauses}`,
  ).run(...values);
}
