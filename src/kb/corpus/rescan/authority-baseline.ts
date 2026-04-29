import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

import { buildNoteIndexEntry, buildSourceIndexEntry } from '../index-records.js';
import {
  extractBody,
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
} from '../frontmatter.js';
import {
  computeContentSurfaceHash,
  computeMetadataSurfaceHash,
} from '../snapshot.js';
import { noteMetadataHash, sourceMetadataHash } from '../../metadata-hash.js';
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

function rawSha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function ensureCorpusAuthorityBaselineTable(db: BetterSqlite3.Database): void {
  db
    .prepare(
      `
        CREATE TABLE IF NOT EXISTS kb_corpus_authority_baseline (
          entry_id      TEXT PRIMARY KEY,
          content_hash  TEXT NOT NULL,
          metadata_hash TEXT NOT NULL
        )
      `,
    )
    .run();
}

export function readCorpusAuthorityBaseline(db: BetterSqlite3.Database): CorpusAuthorityBaselineMap {
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
  return new Map(
    rows.map((row) => [
      row.entry_id,
      {
        entryId: row.entry_id,
        contentHash: row.content_hash,
        metadataHash: row.metadata_hash,
      },
    ]),
  );
}

export function replaceCorpusAuthorityBaseline(
  db: BetterSqlite3.Database,
  records: readonly CorpusAuthorityBaselineRecord[],
): void {
  ensureCorpusAuthorityBaselineTable(db);
  const replace = db.transaction((nextRecords: readonly CorpusAuthorityBaselineRecord[]) => {
    db.prepare('DELETE FROM kb_corpus_authority_baseline').run();
    const insert = db.prepare<[string, string, string]>(
      `
        INSERT INTO kb_corpus_authority_baseline (entry_id, content_hash, metadata_hash)
        VALUES (?, ?, ?)
      `,
    );
    for (const record of [...nextRecords].sort((left, right) => left.entryId.localeCompare(right.entryId))) {
      insert.run(record.entryId, record.contentHash, record.metadataHash);
    }
  });
  replace.immediate(records);
}

export function collectCorpusAuthorityBaseline(scan: CorpusScanView): CorpusAuthorityBaselineRecord[] {
  const records: CorpusAuthorityBaselineRecord[] = [];

  for (const file of scan.markdownFiles) {
    if (file.kind === 'note') {
      try {
        const frontmatter = parseFrontmatter(file.content);
        const title = extractTitle(file.content);
        const entry = buildNoteIndexEntry({
          slug: file.slug,
          title,
          ...frontmatter,
        });
        records.push({
          entryId: file.entryId,
          contentHash: computeContentSurfaceHash({
            title,
            body: extractBody(file.content),
          }),
          metadataHash: noteMetadataHash(entry),
        });
      } catch {
        const rawHash = rawSha256(file.content);
        records.push({
          entryId: file.entryId,
          contentHash: rawHash,
          metadataHash: rawHash,
        });
      }
      continue;
    }

    if (file.kind === 'source') {
      try {
        const { title, ...metadata } = parseSourceFrontmatter(file.content);
        const entry = buildSourceIndexEntry({
          slug: file.slug,
          title,
          ...metadata,
        });
        records.push({
          entryId: file.entryId,
          contentHash: computeContentSurfaceHash({
            title,
            body: extractBody(file.content),
          }),
          metadataHash: sourceMetadataHash(entry),
        });
      } catch {
        const rawHash = rawSha256(file.content);
        records.push({
          entryId: file.entryId,
          contentHash: rawHash,
          metadataHash: rawHash,
        });
      }
      continue;
    }

    records.push({
      entryId: file.entryId,
      contentHash: '',
      metadataHash: computeMetadataSurfaceHash({ rawBytes: file.content }),
    });
  }

  if (scan.entityGraph !== null) {
    records.push({
      entryId: scan.entityGraph.entryId,
      contentHash: '',
      metadataHash: computeMetadataSurfaceHash({ rawBytes: scan.entityGraph.content }),
    });
  }

  return records;
}

export function rebuildCorpusAuthorityBaseline(db: BetterSqlite3.Database, scan: CorpusScanView): CorpusAuthorityBaselineMap {
  const records = collectCorpusAuthorityBaseline(scan);
  replaceCorpusAuthorityBaseline(db, records);
  return new Map(records.map((record) => [record.entryId, record]));
}

export function ensureCorpusAuthorityBaseline(
  db: BetterSqlite3.Database,
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

export function createCorpusAuthorityBaselineStore(db: BetterSqlite3.Database): CorpusAuthorityBaselineStore {
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
