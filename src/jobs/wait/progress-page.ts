import type { JobProgressTiming } from '../event-bodies.js';

export type WaitProgressRow = Readonly<{ seq: number; message: string; timing: JobProgressTiming }>;
export type RawProgressRow = Readonly<{ seq: number; progress?: WaitProgressRow }>;
const pageEvidence: unique symbol = Symbol('raw-progress-page');
export type ProgressPage = Readonly<{
  rows: readonly WaitProgressRow[];
  through: number;
  exhausted: boolean;
  /** Raw rows in this page that carry no message; a page of only these advances its job silently. */
  faultRows: number;
  /** Raw rows the read returned, its lookahead row included: the work this page cost. */
  rawRows: number;
  [pageEvidence]: true;
}>;
export type TailPage = Readonly<{
  rows: readonly WaitProgressRow[];
  through: number;
  frontier: number;
  reachedStart: boolean;
  rawRows: number;
  [pageEvidence]: true;
}>;

export function progressPage(raw: readonly RawProgressRow[], requested: number, sourceFrontier: number): ProgressPage {
  const selected = raw.slice(0, requested);
  const exhausted = raw.length <= requested;
  const rows = selected.flatMap((row) => (row.progress ? [row.progress] : []));
  return {
    rows,
    through: exhausted ? sourceFrontier : selected[selected.length - 1].seq,
    exhausted,
    faultRows: selected.length - rows.length,
    rawRows: raw.length,
    [pageEvidence]: true,
  };
}

export function progressTail(raw: readonly RawProgressRow[], requested: number, sourceFrontier: number): TailPage {
  const selected = raw.slice(0, requested);
  return {
    rows: selected.flatMap((row) => (row.progress ? [row.progress] : [])).reverse(),
    through: selected.at(-1)?.seq ?? 0,
    frontier: sourceFrontier,
    reachedStart: raw.length <= requested,
    rawRows: raw.length,
    [pageEvidence]: true,
  };
}
