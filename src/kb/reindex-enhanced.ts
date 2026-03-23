import type { KbContext } from './types.js';

export type KbReindexNoteRecord = {
  note: string;
  path: string;
  domain: string;
  title: string;
  body: string;
  tags: string[];
  principles: string[];
  source: string[];
  createdAt: string;
  updatedAt: string;
};

type LanceDbConnection = {
  tableNames?: () => Promise<string[]>;
  dropTable: (name: string) => Promise<void>;
  createTable: (name: string, rows: Record<string, unknown>[]) => Promise<unknown>;
  createEmptyTable?: (name: string, schema: LanceDbSchema) => Promise<unknown>;
};

type LanceDbField = {
  name: string;
  type: string;
  nullable: boolean;
};

type LanceDbSchema = {
  fields: LanceDbField[];
  metadata: Map<string, string>;
  get names(): string[];
};

const NOTES_TABLE = 'notes';
const TAGS_TABLE = 'tags';
const PRINCIPLES_TABLE = 'principles';

function asConnection(value: unknown): LanceDbConnection {
  if (
    typeof value !== 'object'
    || value === null
    || typeof (value as Partial<LanceDbConnection>).dropTable !== 'function'
    || typeof (value as Partial<LanceDbConnection>).createTable !== 'function'
  ) {
    throw new Error('Invalid LanceDB connection');
  }

  return value as LanceDbConnection;
}

function stringSchema(columns: string[]): LanceDbSchema {
  return {
    fields: columns.map((name) => ({
      name,
      type: 'utf8',
      nullable: false,
    })),
    metadata: new Map<string, string>(),
    get names(): string[] {
      return this.fields.map((field) => field.name);
    },
  };
}

function normalized(text: string): string {
  return text.toLowerCase();
}

async function dropTableIfPresent(db: LanceDbConnection, name: string): Promise<void> {
  if (typeof db.tableNames === 'function') {
    const tableNames = await db.tableNames();
    if (!tableNames.includes(name)) {
      return;
    }
  }

  try {
    await db.dropTable(name);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('not found') || message.includes('does not exist')) {
      return;
    }
    throw error;
  }
}

async function createTable(
  db: LanceDbConnection,
  name: string,
  rows: Record<string, unknown>[],
  columns: string[],
): Promise<void> {
  if (rows.length > 0) {
    await db.createTable(name, rows);
    return;
  }

  if (typeof db.createEmptyTable === 'function') {
    await db.createEmptyTable(name, stringSchema(columns));
    return;
  }

  await db.createTable(name, rows);
}

export async function rebuildEnhancedIndex(
  kb: KbContext,
  notes: KbReindexNoteRecord[],
): Promise<void> {
  if (kb.adapter === null) {
    return;
  }

  const db = asConnection(await kb.adapter.getDb());
  const noteRows = notes.map((note) => ({
    id: note.note,
    path: note.path,
    note_slug: note.note,
    note_slug_norm: normalized(note.note),
    domain: note.domain,
    title: note.title,
    title_norm: normalized(note.title),
    body: note.body,
    body_norm: normalized(note.body),
    created: note.createdAt,
    updated: note.updatedAt,
  }));
  const tagRows = notes.flatMap((note) => note.tags.map((tag) => ({
    note_id: note.note,
    tag,
    tag_norm: normalized(tag),
  })));
  const principleRows = notes.flatMap((note) => note.principles.map((principle) => ({
    note_id: note.note,
    principle,
    principle_norm: normalized(principle),
  })));

  await dropTableIfPresent(db, NOTES_TABLE);
  await dropTableIfPresent(db, TAGS_TABLE);
  await dropTableIfPresent(db, PRINCIPLES_TABLE);

  await createTable(
    db,
    NOTES_TABLE,
    noteRows,
    ['id', 'path', 'note_slug', 'note_slug_norm', 'domain', 'title', 'title_norm', 'body', 'body_norm', 'created', 'updated'],
  );
  await createTable(
    db,
    TAGS_TABLE,
    tagRows,
    ['note_id', 'tag', 'tag_norm'],
  );
  await createTable(
    db,
    PRINCIPLES_TABLE,
    principleRows,
    ['note_id', 'principle', 'principle_norm'],
  );
}
