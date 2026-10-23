import type { JobDetailResponse } from '../records.js';
import type { JobSendOutcome } from '../send.js';

export type JobDetailLookup =
  | (LocatedJobDetail & Readonly<{ sendRefusal?: Extract<JobSendOutcome, { state: 'refused' }> }>)
  | null;

type LocatedJobDetail =
  | JobDetailResponse
  | Readonly<{
      kind: 'unresolved';
      jobId: string;
      epochKey: string;
    }>
  | Readonly<{
      kind: 'outcome-unrecoverable' | 'outcome-unreadable';
      message?: string;
      jobId: string;
      epochKey: string;
    }>
  | Readonly<{
      kind: 'detail-unreadable';
      jobId: string;
      epochKey: string;
    }>
  | Readonly<{
      kind: 'pre-epoch-history';
      jobId: string;
    }>;
