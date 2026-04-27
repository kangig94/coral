import type BetterSqlite3 from 'better-sqlite3';

import type { CorpusSnapshot } from '../kb/corpus/snapshot.js';

export type ConsumerRegistrationKind = 'base' | 'equipment';

export interface ConsumerApplyError {
  readonly message: string;
  readonly at: string;
  readonly cause?: unknown;
}

export type ConsumerHandleStatus =
  | {
      authority: 'journal';
      cursor: number;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    }
  | {
      authority: 'corpus';
      corpusInterest: CorpusInterest;
      snapshotId: string | null;
      contentSeq: number;
      metadataSeq: number;
      contentManifestHash: string | null;
      metadataManifestHash: string | null;
      pending: boolean;
      lastApplyError: ConsumerApplyError | null;
    };

export interface ConsumerHandle {
  readonly id: string;
  readonly registrationKind: ConsumerRegistrationKind;
  readonly lastApplyError: ConsumerApplyError | null;
  stop(): Promise<void>;
  unregister(): Promise<void>;
  status(): ConsumerHandleStatus;
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
  /**
   * Idempotent apply. Architecture §16 invariant #44:
   * - ConsumerDriver does NOT wrap apply() in a transaction.
   * - apply() owns its own write atomicity.
   * - Cursor advances only on clean return; crash between apply commit and
   *   cursor update is tolerated because the same range re-applies on next start.
   */
  apply(ctx: JournalApplyContext): Promise<void>;
}

export type CorpusLaneHint = 'content' | 'metadata';
export type CorpusInterest = CorpusLaneHint | 'both';

export interface CorpusConsumerApplyContext {
  readonly snapshot: CorpusSnapshot;
  readonly db: BetterSqlite3.Database;
}

export interface CorpusConsumerRegistration {
  readonly id: string;
  readonly authority: 'corpus';
  readonly corpusInterest: CorpusInterest;
  readonly registrationKind?: ConsumerRegistrationKind;
  readonly onApplyFailure?: (err: ConsumerApplyError) => void;
  apply(ctx: CorpusConsumerApplyContext): Promise<void>;
}

export type ConsumerRegistration = JournalConsumerRegistration | CorpusConsumerRegistration;
