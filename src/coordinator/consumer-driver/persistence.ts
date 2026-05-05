import type { KbCorpusSnapshot } from '../../kb/contract.js';
import { normalizeCorpusCursor } from '../../kb/state/corpus-state.js';
import type { Database, Statement } from '../../store/db.js';
import type {
  ConsumerRegistration,
  ConsumerRegistrationKind,
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
  JournalConsumerRegistration,
} from '../../store/consumer-contract.js';
import type { Authority } from './state.js';
import {
  consumerAuthorityMismatchError,
  consumerInterestMismatchError,
  consumerRegistrationKindMismatchError,
  isRegistrationKind,
  laneHintFromInterest,
  parseStoredCorpusInterest,
} from './state.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';

export interface CursorMetadataRow {
  authority: string;
  lane: string | null;
  corpus_interest: string | null;
  registration_kind: string | null;
}

interface JournalCursorRow {
  cursor: number | null;
}

interface CorpusCursorRow {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
}

export class ConsumerCursorRepository {
  private readonly selectCursorMetadataStmt: Statement<[string], CursorMetadataRow>;
  private readonly insertJournalCursorRowStmt: Statement<[string, Authority, string, ConsumerRegistrationKind]>;
  private readonly insertCorpusCursorRowStmt: Statement<
    [string, Authority, CorpusLaneHint | null, CorpusInterest, string, ConsumerRegistrationKind]
  >;
  private readonly updateRegistrationKindStmt: Statement<[ConsumerRegistrationKind, string]>;
  private readonly updateCorpusInterestStmt: Statement<[CorpusInterest, CorpusLaneHint | null, string]>;
  private readonly deleteCursorRowStmt: Statement<[string]>;
  private readonly readJournalCursorStmt: Statement<[string], JournalCursorRow>;
  private readonly readCorpusCursorStmt: Statement<[string], CorpusCursorRow>;
  private readonly advanceJournalCursorStmt: Statement<[number, string, number]>;
  private readonly advanceContentCursorStmt: Statement<
    [string, number, number, string, string, string, number, number, string]
  >;
  private readonly advanceMetadataCursorStmt: Statement<
    [string, number, number, string, string, string, number, number, string]
  >;
  private readonly advanceBothCursorStmt: Statement<
    [string, number, number, string, string, string, number, number, string]
  >;

  constructor(
    private readonly db: Database,
    private readonly now: () => Date,
  ) {
    this.selectCursorMetadataStmt = this.db.prepare<[string], CursorMetadataRow>(
      'SELECT authority, lane, corpus_interest, registration_kind FROM consumer_cursors WHERE consumer_id = ?',
    );
    this.insertJournalCursorRowStmt = this.db.prepare<[string, Authority, string, ConsumerRegistrationKind]>(
      `
        INSERT INTO consumer_cursors (
          consumer_id,
          authority,
          cursor,
          registered_at,
          registration_kind
        ) VALUES (?, ?, 0, ?, ?)
      `,
    );
    this.insertCorpusCursorRowStmt = this.db.prepare<
      [string, Authority, CorpusLaneHint | null, CorpusInterest, string, ConsumerRegistrationKind]
    >(
      `
        INSERT INTO consumer_cursors (
          consumer_id,
          authority,
          lane,
          corpus_interest,
          cursor,
          snapshot_id,
          content_seq,
          metadata_seq,
          content_manifest_hash,
          metadata_manifest_hash,
          registered_at,
          registration_kind
        ) VALUES (?, ?, ?, ?, NULL, '', 0, 0, '', '', ?, ?)
      `,
    );
    this.updateRegistrationKindStmt = this.db.prepare<[ConsumerRegistrationKind, string]>(
      'UPDATE consumer_cursors SET registration_kind = ? WHERE consumer_id = ?',
    );
    this.updateCorpusInterestStmt = this.db.prepare<[CorpusInterest, CorpusLaneHint | null, string]>(
      'UPDATE consumer_cursors SET corpus_interest = ?, lane = ? WHERE consumer_id = ?',
    );
    this.deleteCursorRowStmt = this.db.prepare<[string]>('DELETE FROM consumer_cursors WHERE consumer_id = ?');
    this.readJournalCursorStmt = this.db.prepare<[string], JournalCursorRow>(
      'SELECT cursor FROM consumer_cursors WHERE consumer_id = ?',
    );
    this.readCorpusCursorStmt = this.db.prepare<[string], CorpusCursorRow>(
      `
        SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash
          FROM consumer_cursors
         WHERE consumer_id = ?
      `,
    );
    this.advanceJournalCursorStmt = this.db.prepare<[number, string, number]>(
      'UPDATE consumer_cursors SET cursor = ? WHERE consumer_id = ? AND cursor < ?',
    );
    this.advanceContentCursorStmt = this.db.prepare<
      [string, number, number, string, string, string, number, number, string]
    >(
      `
        UPDATE consumer_cursors
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?
         WHERE consumer_id = ?
           AND (content_seq < ? OR (content_seq = ? AND content_manifest_hash != ?))
      `,
    );
    this.advanceMetadataCursorStmt = this.db.prepare<
      [string, number, number, string, string, string, number, number, string]
    >(
      `
        UPDATE consumer_cursors
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?
         WHERE consumer_id = ?
           AND (metadata_seq < ? OR (metadata_seq = ? AND metadata_manifest_hash != ?))
      `,
    );
    this.advanceBothCursorStmt = this.db.prepare<
      [string, number, number, string, string, string, number, number, string]
    >(
      `
        UPDATE consumer_cursors
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?
         WHERE consumer_id = ?
           AND (content_seq < ? OR metadata_seq < ? OR snapshot_id != ?)
      `,
    );
  }

  readCursorMetadata(consumerId: string): CursorMetadataRow | undefined {
    return this.selectCursorMetadataStmt.get(consumerId);
  }

  ensureCursorRow(
    reg: ConsumerRegistration,
    allowMetadataUpdate = true,
    preloadedRow?: CursorMetadataRow,
  ): ConsumerRegistrationKind {
    if (reg.kind === 'stateless') {
      const row = preloadedRow ?? this.selectCursorMetadataStmt.get(reg.id);
      if (row !== undefined) {
        this.deleteCursorRowStmt.run(reg.id);
      }
      return 'stateless';
    }

    const row = preloadedRow ?? this.selectCursorMetadataStmt.get(reg.id);
    const requestedKind = reg.registrationKind;

    if (row) {
      if (row.authority !== reg.authority) {
        throw consumerAuthorityMismatchError(reg.id, reg.authority, row.authority);
      }
      if (reg.authority === 'corpus') {
        const storedInterest = parseStoredCorpusInterest(row);
        if (storedInterest !== reg.corpusInterest) {
          // Stored interest came from a previous coral version. The interest
          // is declared in code (bundled engines or expansion adapters), not
          // user state, so a fresh registration may legitimately widen or
          // narrow it across version bumps. Update in place; cursor counters
          // (snapshot_id, content_seq, metadata_seq) reset on next apply when
          // the consumer rebuilds against the current corpus snapshot.
          if (!allowMetadataUpdate) {
            throw consumerInterestMismatchError(reg.id);
          }
          this.updateCorpusInterestStmt.run(reg.corpusInterest, laneHintFromInterest(reg.corpusInterest), reg.id);
        }
      }

      const storedKind = this.parseStoredRegistrationKind(reg.id, row.registration_kind);
      if (requestedKind !== undefined && storedKind !== requestedKind) {
        if (!allowMetadataUpdate) {
          throw consumerRegistrationKindMismatchError(reg.id, requestedKind, storedKind);
        }
        this.updateRegistrationKindStmt.run(requestedKind, reg.id);
        return requestedKind;
      }

      return storedKind;
    }

    const registrationKind = requestedKind ?? 'base';
    this.insertCursorRow(reg, registrationKind);
    return registrationKind;
  }

  insertCursorRow(reg: ConsumerRegistration, registrationKind: ConsumerRegistrationKind): void {
    if (reg.kind === 'stateless' || registrationKind === 'stateless') {
      return;
    }
    const nowIso = this.now().toISOString();
    if (reg.authority === 'journal') {
      this.insertJournalCursorRowStmt.run(reg.id, reg.authority, nowIso, registrationKind);
      return;
    }

    this.insertCorpusCursorRowStmt.run(
      reg.id,
      reg.authority,
      laneHintFromInterest(reg.corpusInterest),
      reg.corpusInterest,
      nowIso,
      registrationKind,
    );
  }

  parseStoredRegistrationKind(
    consumerId: string,
    registrationKind: string | null | undefined,
  ): ConsumerRegistrationKind {
    const value = registrationKind ?? 'base';
    if (isRegistrationKind(value)) {
      return value;
    }

    throw documentedCoralSetupError('consumer_registration_kind_invalid', { id: consumerId });
  }

  readJournalCursor(consumerId: string): number {
    const row = this.readJournalCursorStmt.get(consumerId);
    return row?.cursor ?? 0;
  }

  readCorpusCursor(consumerId: string): KbCorpusSnapshot {
    return normalizeCorpusCursor(this.readCorpusCursorStmt.get(consumerId));
  }

  advanceJournalCursor(reg: JournalConsumerRegistration, newCursor: number): void {
    this.ensureCursorRow(reg);
    this.advanceJournalCursorStmt.run(newCursor, reg.id, newCursor);
  }

  advanceCorpusCursor(reg: CorpusConsumerRegistration, snapshot: KbCorpusSnapshot): void {
    this.ensureCursorRow(reg);

    if (reg.corpusInterest === 'content') {
      this.advanceContentCursorStmt.run(
        snapshot.snapshotId,
        snapshot.contentSeq,
        snapshot.metadataSeq,
        snapshot.contentManifestHash,
        snapshot.metadataManifestHash,
        reg.id,
        snapshot.contentSeq,
        snapshot.contentSeq,
        snapshot.contentManifestHash,
      );
      return;
    }

    if (reg.corpusInterest === 'metadata') {
      this.advanceMetadataCursorStmt.run(
        snapshot.snapshotId,
        snapshot.contentSeq,
        snapshot.metadataSeq,
        snapshot.contentManifestHash,
        snapshot.metadataManifestHash,
        reg.id,
        snapshot.metadataSeq,
        snapshot.metadataSeq,
        snapshot.metadataManifestHash,
      );
      return;
    }

    this.advanceBothCursorStmt.run(
      snapshot.snapshotId,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentManifestHash,
      snapshot.metadataManifestHash,
      reg.id,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.snapshotId,
    );
  }

  deleteExpansionCursor(consumerId: string): void {
    this.deleteCursorRowStmt.run(consumerId);
  }
}
