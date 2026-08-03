import { z } from 'zod';

import type { KbCorpusSnapshot } from '../kb/contract.js';
import { normalizeCorpusCursor } from '../kb/state/corpus-state.js';
import type { Database, Statement } from '../store/db.js';
import type {
  ConsumerRegistration,
  ConsumerRegistrationKind,
  CorpusConsumerRegistration,
  CorpusInterest,
  CorpusLaneHint,
  JournalConsumerRegistration,
} from '../store/consumer-contract.js';
import { documentedCoralSetupError } from '../runtime/errors.js';
import type { Authority } from './state.js';
import {
  consumerAuthorityMismatchError,
  consumerInterestMismatchError,
  consumerRegistrationKindMismatchError,
  laneHintFromInterest,
} from './state.js';

const persistedRegistrationKindSchema = z.enum(['base', 'expansion']);

export const consumerCursorMetadataSchema = z.union([
  z
    .object({
      authority: z.literal('journal'),
      lane: z.null(),
      corpus_interest: z.null(),
      registration_kind: persistedRegistrationKindSchema,
    })
    .strict(),
  z
    .object({
      authority: z.literal('corpus'),
      lane: z.literal('content'),
      corpus_interest: z.literal('content'),
      registration_kind: persistedRegistrationKindSchema,
    })
    .strict(),
  z
    .object({
      authority: z.literal('corpus'),
      lane: z.literal('metadata'),
      corpus_interest: z.literal('metadata'),
      registration_kind: persistedRegistrationKindSchema,
    })
    .strict(),
  z
    .object({
      authority: z.literal('corpus'),
      lane: z.null(),
      corpus_interest: z.literal('both'),
      registration_kind: persistedRegistrationKindSchema,
    })
    .strict(),
]);
export type CursorMetadataRow = z.infer<typeof consumerCursorMetadataSchema>;
type RawCursorMetadataRow = {
  authority: string;
  lane: string | null;
  corpus_interest: string | null;
  registration_kind: string | null;
};

export type RetiredExpansionCursorPreflight = { readonly status: 'missing' } | { readonly status: 'expansion-owned' };

export const journalConsumerCursorSchema = z.object({ cursor: z.number().int().nonnegative() }).strict();
type JournalCursorRow = z.infer<typeof journalConsumerCursorSchema>;

export const corpusConsumerCursorSchema = z
  .object({
    snapshot_id: z.string(),
    content_seq: z.number().int().nonnegative(),
    metadata_seq: z.number().int().nonnegative(),
    content_manifest_hash: z.string(),
    metadata_manifest_hash: z.string(),
  })
  .strict();
type CorpusCursorRow = z.infer<typeof corpusConsumerCursorSchema>;

export class ConsumerCursorRepository {
  private readonly selectCursorMetadataStmt: Statement<[string], RawCursorMetadataRow>;
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
  private readonly repairCorpusCursorStmt: Statement<[string, number, number, string, string, string]>;

  private readonly db: Database;
  private readonly now: () => Date;
  constructor(db: Database, now: () => Date) {
    this.db = db;
    this.now = now;
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
    this.repairCorpusCursorStmt = this.db.prepare<[string, number, number, string, string, string]>(
      `
        UPDATE consumer_cursors
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?
         WHERE consumer_id = ?
           AND authority = 'corpus'
      `,
    );
  }

  ensureCursorRow(
    reg: ConsumerRegistration,
    allowMetadataUpdate = true,
    registrationKindIfMissing?: ConsumerRegistrationKind,
  ): ConsumerRegistrationKind {
    if (reg.kind === 'stateless') {
      const row = this.selectCursorMetadataStmt.get(reg.id);
      if (row !== undefined) {
        this.deleteCursorRowStmt.run(reg.id);
      }
      return 'stateless';
    }

    const rawRow = this.selectCursorMetadataStmt.get(reg.id);
    if (rawRow !== undefined && rawRow.authority !== reg.authority) {
      throw consumerAuthorityMismatchError(reg.id, reg.authority, rawRow.authority);
    }
    const row = rawRow === undefined ? undefined : consumerCursorMetadataSchema.parse(rawRow);
    const requestedKind = reg.registrationKind;

    if (row) {
      if (reg.authority === 'corpus') {
        if (row.authority !== 'corpus') {
          throw consumerAuthorityMismatchError(reg.id, reg.authority, row.authority);
        }
        const storedInterest = row.corpus_interest;
        if (storedInterest !== reg.corpusInterest) {
          // Registration declarations are executable configuration. Reconcile
          // a current declaration change while preserving its current cursor.
          if (!allowMetadataUpdate) {
            throw consumerInterestMismatchError(reg.id);
          }
          this.updateCorpusInterestStmt.run(reg.corpusInterest, laneHintFromInterest(reg.corpusInterest), reg.id);
        }
      }

      const storedKind = row.registration_kind;
      if (requestedKind !== undefined && storedKind !== requestedKind) {
        if (!allowMetadataUpdate) {
          throw consumerRegistrationKindMismatchError(reg.id, requestedKind, storedKind);
        }
        this.updateRegistrationKindStmt.run(requestedKind, reg.id);
        return requestedKind;
      }

      return storedKind;
    }

    const registrationKind = requestedKind ?? registrationKindIfMissing ?? 'base';
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

  readJournalCursor(consumerId: string): number {
    const row = this.readJournalCursorStmt.get(consumerId);
    return row === undefined ? 0 : journalConsumerCursorSchema.parse(row).cursor;
  }

  readCorpusCursor(consumerId: string): KbCorpusSnapshot {
    const row = this.readCorpusCursorStmt.get(consumerId);
    return normalizeCorpusCursor(row === undefined ? undefined : corpusConsumerCursorSchema.parse(row));
  }

  preflightRetiredExpansionCursor(consumerId: string): RetiredExpansionCursorPreflight {
    const raw = this.selectCursorMetadataStmt.get(consumerId);
    if (raw === undefined) {
      return { status: 'missing' };
    }
    const parsed = consumerCursorMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      throw documentedCoralSetupError('retired_expansion_cursor_unsafe', {
        name: consumerId,
        reason: 'invalid persisted cursor metadata',
      });
    }
    if (parsed.data.registration_kind !== 'expansion') {
      throw documentedCoralSetupError('retired_expansion_cursor_unsafe', {
        name: consumerId,
        reason: `cursor is owned by ${parsed.data.registration_kind}`,
      });
    }
    return { status: 'expansion-owned' };
  }

  deletePreflightedRetiredExpansionCursor(consumerId: string, preflight: RetiredExpansionCursorPreflight): void {
    if (preflight.status === 'missing') {
      if (this.selectCursorMetadataStmt.get(consumerId) !== undefined) {
        throw documentedCoralSetupError('retired_expansion_cursor_changed', { name: consumerId });
      }
      return;
    }
    const result = this.db
      .prepare<[string]>("DELETE FROM consumer_cursors WHERE consumer_id = ? AND registration_kind = 'expansion'")
      .run(consumerId);
    if (Number(result.changes) !== 1) {
      throw documentedCoralSetupError('retired_expansion_cursor_changed', { name: consumerId });
    }
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

  repairCorpusCursor(reg: CorpusConsumerRegistration, snapshot: KbCorpusSnapshot): void {
    const result = this.repairCorpusCursorStmt.run(
      snapshot.snapshotId,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentManifestHash,
      snapshot.metadataManifestHash,
      reg.id,
    );
    if (Number(result.changes) !== 1) {
      throw new Error(`Corpus cursor repair failed because consumer '${reg.id}' has no durable cursor row`);
    }
  }

  deleteExpansionCursor(consumerId: string): void {
    this.deleteCursorRowStmt.run(consumerId);
  }
}
