import type { JobDetailResponse } from '../records.js';

export type WaitCursorError = Readonly<{
  code:
    | 'wait_cursor_epoch_required'
    | 'wait_cursor_mismatch'
    | 'wait_epoch_unsupported'
    | 'wait_cursor_unsupported'
    | 'wait_cursor_malformed'
    | 'jobs_not_found'
    | 'job_pre_epoch_history'
    | 'transient'
    | 'scope_mismatch'
    | 'job_outcome_unrecoverable';
  message: string;
  detail?: { jobs: string[]; disposition?: string };
  remediation?: string;
}>;

export type JobDetailLookup =
  | JobDetailResponse
  | Readonly<{
      kind: 'unresolved';
      jobId: string;
      epochKey: string;
    }>
  | Readonly<{
      kind: 'outcome-unrecoverable';
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
    }>
  | null;
