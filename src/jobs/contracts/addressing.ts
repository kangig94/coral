import type { JobDetailResponse } from '../records.js';

export type WaitCursorError = Readonly<{
  code: 'wait_cursor_epoch_required' | 'wait_cursor_mismatch';
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
      kind: 'pre-epoch-history';
      jobId: string;
    }>
  | null;
