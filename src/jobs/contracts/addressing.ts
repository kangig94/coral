import type { JobDetailResponse } from '../records.js';

/** Both refusals are soft: the client drops its cursor and starts a fresh collection. */
export type WaitCursorError = Readonly<{
  code: 'wait_cursor_mismatch' | 'wait_cursor_malformed';
  message: string;
}>;

export type JobDetailLookup =
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
    }>
  | null;
