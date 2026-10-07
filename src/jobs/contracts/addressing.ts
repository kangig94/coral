import type { JobDetailResponse } from '../records.js';

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
