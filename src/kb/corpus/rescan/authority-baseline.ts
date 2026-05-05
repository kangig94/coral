import { withImmediate, type Database } from '../../../store/db.js';
import { buildCorpusSurface } from '../surface.js';
import type { CorpusScanView } from './scan.js';
import type {
  CorpusAuthorityBaselineMap,
  CorpusAuthorityBaselineRecord,
  CorpusAuthorityBaselineStore,
} from '../authority-baseline-contract.js';

type BaselineRow = {
  entry_id: string;
  content_hash: string;
  metadata_hash: string;
};

export function ensureCorpusAuthorityBaselineTable(db: Database): void {
  db.prepare(
    `
        CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline (
          entry_id      TEXT PRIMARY KEY,
          content_hash  TEXT NOT NULL,
          metadata_hash TEXT NOT NULL
        )
      `,
  ).run();
}

export function readCorpusAuthorityBaseline(db: Database): CorpusAuthorityBaselineMap {
  ensureCorpusAuthorityBaselineTable(db);
  const rows = db
    .prepare<[], BaselineRow>(
      `
        SELECT entry_id, content_hash, metadata_hash
          FROM kb_corpus_authority_baseline
         ORDER BY entry_id
      `,
    )
    .all();
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

export function replaceCorpusAuthorityBaseline(db: Database, records: readonly CorpusAuthorityBaselineRecord[]): void {
  ensureCorpusAuthorityBaselineTable(db);
  withImmediate(db, () => {
    db.prepare('DELETE FROM kb_corpus_authority_baseline').run();
    const insert = db.prepare<[string, string, string]>(
      `
        INSERT INTO kb_corpus_authority_baseline (entry_id, content_hash, metadata_hash)
        VALUES (?, ?, ?)
      `,
    );
    for (const record of [...records].sort((left, right) => left.entryId.localeCompare(right.entryId))) {
      insert.run(record.entryId, record.contentHash, record.metadataHash);
    }
  });
}

export function collectCorpusAuthorityBaseline(scan: CorpusScanView): CorpusAuthorityBaselineRecord[] {
  return [...buildCorpusSurface(scan).baselineRecords];
}

export function rebuildCorpusAuthorityBaseline(db: Database, scan: CorpusScanView): CorpusAuthorityBaselineMap {
  const records = collectCorpusAuthorityBaseline(scan);
  replaceCorpusAuthorityBaseline(db, records);
  const baseline: CorpusAuthorityBaselineMap = new Map();
  for (const record of records) {
    baseline.set(record.entryId, record);
  }
  return baseline;
}

export function ensureCorpusAuthorityBaseline(
  db: Database,
  scan: CorpusScanView,
): { readonly baseline: CorpusAuthorityBaselineMap; readonly rebuilt: boolean } {
  const baseline = readCorpusAuthorityBaseline(db);
  if (baseline.size > 0 || (scan.markdownFiles.length === 0 && scan.entityGraph === null)) {
    return { baseline, rebuilt: false };
  }

  return {
    baseline: rebuildCorpusAuthorityBaseline(db, scan),
    rebuilt: true,
  };
}

export function createCorpusAuthorityBaselineStore(db: Database): CorpusAuthorityBaselineStore {
  return {
    ensure(scan) {
      return ensureCorpusAuthorityBaseline(db, scan as CorpusScanView);
    },
    rebuild(scan) {
      return rebuildCorpusAuthorityBaseline(db, scan as CorpusScanView);
    },
    read() {
      return readCorpusAuthorityBaseline(db);
    },
    replace(records) {
      replaceCorpusAuthorityBaseline(db, records);
    },
  };
}
