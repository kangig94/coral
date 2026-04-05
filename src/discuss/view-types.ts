/**
 * Discuss view DTO types shared between views.ts (canonical definitions)
 * and projections.ts (builders). Extracted to break the views ↔ projections cycle.
 */
import type { TranscriptEntry } from './types.js';

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
