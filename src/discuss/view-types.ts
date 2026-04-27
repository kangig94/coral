// Discuss transcript DTO types — exists to break a `read-contract.ts ↔
// projections.ts` cycle (read-contract builds the DTO, projections types it).
// The split is documented because a cycle physically forces it; otherwise
// the types would live in read-contract.ts.
import type { TranscriptEntry } from './session-types.js';

type DiscussBidTranscriptEntry = Extract<TranscriptEntry, { type: 'bids' }>;
type DiscussNonBidTranscriptEntry = Exclude<TranscriptEntry, { type: 'bids' }>;

export type DiscussControlBidsTranscriptEntryDto = Omit<
  DiscussBidTranscriptEntry,
  'bids' | 'effective_bids' | 'thoughts'
>;

export type DiscussControlTranscriptEntryDto = DiscussControlBidsTranscriptEntryDto | DiscussNonBidTranscriptEntry;

export type DiscussAuditTranscriptEntryDto = TranscriptEntry;

export type DiscussControlView = {
  transcript: DiscussControlTranscriptEntryDto[];
  lastSeq: number;
};

export type DiscussAuditView = {
  transcript: DiscussAuditTranscriptEntryDto[];
  lastSeq: number;
};
