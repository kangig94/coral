import type { JobProgressTiming } from '../event-bodies.js';

export type WaitProgressRow = Readonly<{ seq: number; message: string; timing: JobProgressTiming }>;
export type RawProgressRow = Readonly<{ seq: number; progress?: WaitProgressRow }>;
const pageEvidence: unique symbol = Symbol('raw-progress-page');
export type ProgressPage = Readonly<{
  rows: readonly WaitProgressRow[];
  through: number;
  exhausted: boolean;
  [pageEvidence]: true;
}>;
export type TailPage = Readonly<{
  rows: readonly WaitProgressRow[];
  through: number;
  frontier: number;
  reachedStart: boolean;
  [pageEvidence]: true;
}>;

export function progressPage(raw: readonly RawProgressRow[], requested: number, sourceFrontier: number): ProgressPage {
  const selected = raw.slice(0, requested);
  const exhausted = raw.length <= requested;
  return {
    rows: selected.flatMap((row) => (row.progress ? [row.progress] : [])),
    through: exhausted ? sourceFrontier : selected[selected.length - 1].seq,
    exhausted,
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
    [pageEvidence]: true,
  };
}
