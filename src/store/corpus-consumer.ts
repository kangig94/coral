import type BetterSqlite3 from 'better-sqlite3';

import type { CorpusSnapshot as KbCorpusSnapshot } from '../kb/corpus/snapshot.js';

export type CorpusSnapshot = KbCorpusSnapshot;
export type CorpusLaneHint = 'content' | 'metadata';
export type CorpusInterest = CorpusLaneHint | 'both';
export type ConsumerRegistrationKind = 'base' | 'equipment';

export interface ConsumerApplyError {
  readonly message: string;
  readonly at: string;
  readonly cause?: unknown;
}

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
