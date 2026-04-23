import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerApplyError, ConsumerRegistrationKind } from '../../store/consumer-contract.js';
import type { CorpusSnapshot } from './snapshot.js';

export type { ConsumerApplyError, ConsumerRegistrationKind } from '../../store/consumer-contract.js';
export type { CorpusSnapshot } from './snapshot.js';

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
