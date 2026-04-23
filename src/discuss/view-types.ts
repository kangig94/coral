/**
 * Discuss transcript DTO types shared between api.ts and projections.ts.
 */
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
