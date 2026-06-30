import { withImmediate, type Database } from '../../../store/db.js';
import { buildCorpusSurface } from '../surface.js';
import type { CorpusScanView } from './scan.js';
import type {
  CorpusAuthorityBaselineDelta,
  CorpusAuthorityBaselineGeneration,
  CorpusAuthorityBaselineMap,
  CorpusAuthorityBaselineRecord,
  CorpusAuthorityBaselineStore,
} from '../authority-baseline-contract.js';

const ACTIVE_BASELINE_SINGLETON_ID = 1;
const EMPTY_BASELINE_GENERATION_ID = 'empty';

type BaselineRow = {
  entry_id: string;
  content_hash: string;
  metadata_hash: string;
};

type ActiveGenerationRow = {
  generation_id: string;
};

export function ensureCorpusAuthorityBaselineTable(db: Database): void {
  db.prepare(
    `
      CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline_generations (
        generation_id  TEXT PRIMARY KEY,
        committed      INTEGER NOT NULL DEFAULT 0
      )
    `,
  ).run();
  db.prepare(
    `
      CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline_records (
        generation_id  TEXT NOT NULL,
        entry_id       TEXT NOT NULL,
        content_hash   TEXT NOT NULL,
        metadata_hash  TEXT NOT NULL,
        PRIMARY KEY (generation_id, entry_id),
        FOREIGN KEY (generation_id)
          REFERENCES kb_corpus_authority_baseline_generations (generation_id)
          ON DELETE CASCADE
      )
    `,
  ).run();
  db.prepare(
    `
      CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline_active (
        singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation_id  TEXT NOT NULL,
        FOREIGN KEY (generation_id)
          REFERENCES kb_corpus_authority_baseline_generations (generation_id)
          ON DELETE RESTRICT
      )
    `,
  ).run();
  ensureActiveBaselineGeneration(db);
}

export function readCorpusAuthorityBaseline(db: Database): CorpusAuthorityBaselineMap {
  ensureCorpusAuthorityBaselineTable(db);
  const generationId = readActiveBaselineGenerationIdUnchecked(db);
  const rows = db
    .prepare<[string], BaselineRow>(
      `
        SELECT entry_id, content_hash, metadata_hash
          FROM kb_corpus_authority_baseline_records
         WHERE generation_id = ?
         ORDER BY entry_id
      `,
    )
    .all(generationId);
  const baseline: CorpusAuthorityBaselineMap = new Map();
  for (const row of rows) {
    baseline.set(row.entry_id, {
      entryId: row.entry_id,
      contentHash: row.content_hash,
      metadataHash: row.metadata_hash,
    });
  }
  return baseline;
}

export function readActiveBaselineGenerationId(db: Database): string {
  ensureCorpusAuthorityBaselineTable(db);
  return readActiveBaselineGenerationIdUnchecked(db);
}

export function replaceCorpusAuthorityBaseline(
  db: Database,
  records: readonly CorpusAuthorityBaselineRecord[],
  generationId: string,
): void {
  const generation = stageCorpusAuthorityBaselineReplacement(db, records, generationId);
  adoptCorpusAuthorityBaselineGeneration(db, generation.generationId);
  cleanupInactiveCorpusAuthorityBaselineGenerations(db);
}

export function stageCorpusAuthorityBaselineReplacement(
  db: Database,
  records: readonly CorpusAuthorityBaselineRecord[],
  generationId: string,
): CorpusAuthorityBaselineGeneration {
  ensureCorpusAuthorityBaselineTable(db);
  withImmediate(db, () => {
    db.prepare<[string]>('DELETE FROM kb_corpus_authority_baseline_records WHERE generation_id = ?').run(
      generationId,
    );
    db.prepare<[string]>('DELETE FROM kb_corpus_authority_baseline_generations WHERE generation_id = ?').run(
      generationId,
    );
    db.prepare<[string]>(
      `
        INSERT INTO kb_corpus_authority_baseline_generations (generation_id, committed)
        VALUES (?, 0)
      `,
    ).run(generationId);
    const insert = db.prepare<[string, string, string, string]>(
      `
        INSERT INTO kb_corpus_authority_baseline_records (generation_id, entry_id, content_hash, metadata_hash)
        VALUES (?, ?, ?, ?)
      `,
    );
    for (const record of [...records].sort((left, right) => left.entryId.localeCompare(right.entryId))) {
      insert.run(generationId, record.entryId, record.contentHash, record.metadataHash);
    }
  });
  return { generationId };
}

export function adoptCorpusAuthorityBaselineGeneration(db: Database, generationId: string): void {
  ensureCorpusAuthorityBaselineTable(db);
  const exists =
    db
      .prepare<[string], ActiveGenerationRow>(
        `
          SELECT generation_id
            FROM kb_corpus_authority_baseline_generations
           WHERE generation_id = ?
        `,
      )
      .get(generationId) !== undefined;
  if (!exists) {
    throw new Error(`Cannot adopt missing corpus authority baseline generation ${generationId}.`);
  }

  withImmediate(db, () => {
    db.prepare<[number, string]>(
      `
        INSERT INTO kb_corpus_authority_baseline_active (singleton, generation_id)
        VALUES (?, ?)
        ON CONFLICT(singleton) DO UPDATE SET generation_id = excluded.generation_id
      `,
    ).run(ACTIVE_BASELINE_SINGLETON_ID, generationId);
    db.prepare<[string]>(
      `
        UPDATE kb_corpus_authority_baseline_generations
           SET committed = 1
         WHERE generation_id = ?
      `,
    ).run(generationId);
  });
}

export function discardCorpusAuthorityBaselineGeneration(db: Database, generationId: string): void {
  ensureCorpusAuthorityBaselineTable(db);
  if (readActiveBaselineGenerationIdUnchecked(db) === generationId) {
    return;
  }
  withImmediate(db, () => {
    db.prepare<[string]>('DELETE FROM kb_corpus_authority_baseline_records WHERE generation_id = ?').run(
      generationId,
    );
    db.prepare<[string]>('DELETE FROM kb_corpus_authority_baseline_generations WHERE generation_id = ?').run(
      generationId,
    );
  });
}

export function applyCorpusAuthorityBaselineDelta(db: Database, delta: CorpusAuthorityBaselineDelta): void {
  ensureCorpusAuthorityBaselineTable(db);
  const generationId = readActiveBaselineGenerationIdUnchecked(db);
  withImmediate(db, () => {
    const deleteRecord = db.prepare<[string, string]>(
      `
        DELETE FROM kb_corpus_authority_baseline_records
         WHERE generation_id = ?
           AND entry_id = ?
      `,
    );
    for (const entryId of delta.deletes) {
      deleteRecord.run(generationId, entryId);
    }

    const upsert = db.prepare<[string, string, string, string]>(
      `
        INSERT INTO kb_corpus_authority_baseline_records (generation_id, entry_id, content_hash, metadata_hash)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(generation_id, entry_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          metadata_hash = excluded.metadata_hash
      `,
    );
    for (const record of delta.upserts) {
      upsert.run(generationId, record.entryId, record.contentHash, record.metadataHash);
    }
  });
}

export function cleanupInactiveCorpusAuthorityBaselineGenerations(db: Database): void {
  ensureCorpusAuthorityBaselineTable(db);
  const activeGenerationId = readActiveBaselineGenerationIdUnchecked(db);
  withImmediate(db, () => {
    db.prepare<[string]>('DELETE FROM kb_corpus_authority_baseline_records WHERE generation_id <> ?').run(
      activeGenerationId,
    );
    db.prepare<[string]>('DELETE FROM kb_corpus_authority_baseline_generations WHERE generation_id <> ?').run(
      activeGenerationId,
    );
  });
}

export function collectCorpusAuthorityBaseline(scan: CorpusScanView): CorpusAuthorityBaselineRecord[] {
  return [...buildCorpusSurface(scan).baselineRecords];
}

export function rebuildCorpusAuthorityBaseline(
  db: Database,
  scan: CorpusScanView,
  generationId: string,
): CorpusAuthorityBaselineMap {
  const records = collectCorpusAuthorityBaseline(scan);
  replaceCorpusAuthorityBaseline(db, records, generationId);
  const baseline: CorpusAuthorityBaselineMap = new Map();
  for (const record of records) {
    baseline.set(record.entryId, record);
  }
  return baseline;
}

export function ensureCorpusAuthorityBaseline(
  db: Database,
  scan: CorpusScanView,
  uuid: () => string,
): { readonly baseline: CorpusAuthorityBaselineMap; readonly rebuilt: boolean } {
  const baseline = readCorpusAuthorityBaseline(db);
  if (baseline.size > 0 || (scan.markdownFiles.length === 0 && scan.entityGraph === null)) {
    return { baseline, rebuilt: false };
  }

  return {
    baseline: rebuildCorpusAuthorityBaseline(db, scan, `baseline-${uuid()}`),
    rebuilt: true,
  };
}

export function createCorpusAuthorityBaselineStore(
  db: Database,
  uuid: () => string,
): CorpusAuthorityBaselineStore {
  return {
    ensure(scan) {
      return ensureCorpusAuthorityBaseline(db, scan as CorpusScanView, uuid);
    },
    rebuild(scan) {
      return rebuildCorpusAuthorityBaseline(db, scan as CorpusScanView, `baseline-${uuid()}`);
    },
    read() {
      return readCorpusAuthorityBaseline(db);
    },
    replace(records) {
      replaceCorpusAuthorityBaseline(db, records, `baseline-${uuid()}`);
    },
    readActiveGenerationId() {
      return readActiveBaselineGenerationId(db);
    },
    stageReplacement(records, generationId) {
      return stageCorpusAuthorityBaselineReplacement(db, records, generationId ?? `baseline-${uuid()}`);
    },
    adoptStagedGeneration(generationId) {
      adoptCorpusAuthorityBaselineGeneration(db, generationId);
    },
    discardStagedGeneration(generationId) {
      discardCorpusAuthorityBaselineGeneration(db, generationId);
    },
    applyDelta(delta) {
      applyCorpusAuthorityBaselineDelta(db, delta);
    },
    cleanupInactiveGenerations() {
      cleanupInactiveCorpusAuthorityBaselineGenerations(db);
    },
  };
}

function ensureActiveBaselineGeneration(db: Database): void {
  const current = db
    .prepare<[number], ActiveGenerationRow>(
      `
        SELECT generation_id
          FROM kb_corpus_authority_baseline_active
         WHERE singleton = ?
      `,
    )
    .get(ACTIVE_BASELINE_SINGLETON_ID);
  if (current !== undefined) {
    return;
  }

  withImmediate(db, () => {
    db.prepare<[string]>(
      `
        INSERT OR IGNORE INTO kb_corpus_authority_baseline_generations (generation_id, committed)
        VALUES (?, 1)
      `,
    ).run(EMPTY_BASELINE_GENERATION_ID);
    db.prepare<[number, string]>(
      `
        INSERT INTO kb_corpus_authority_baseline_active (singleton, generation_id)
        VALUES (?, ?)
      `,
    ).run(ACTIVE_BASELINE_SINGLETON_ID, EMPTY_BASELINE_GENERATION_ID);
  });
}

function readActiveBaselineGenerationIdUnchecked(db: Database): string {
  const row = db
    .prepare<[number], ActiveGenerationRow>(
      `
        SELECT generation_id
          FROM kb_corpus_authority_baseline_active
         WHERE singleton = ?
      `,
    )
    .get(ACTIVE_BASELINE_SINGLETON_ID);
  return row?.generation_id ?? EMPTY_BASELINE_GENERATION_ID;
}
