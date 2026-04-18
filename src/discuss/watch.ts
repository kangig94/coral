/**
 * Discuss-owned watch contracts.
 *
 * `WatchEvent` and `WatchState` are discuss domain types that describe the
 * shape of watch data produced by projections and consumed by execution
 * runtime. Runtime-only watch machinery (WatchBuffer, WatchSubscriber,
 * LiveDiscussSession internals) stay in `src/discuss/shell/context.ts`.
 */

export type WatchEvent = {
  type: 'bid_resolved' | 'speech_done' | 'epoch_transition' | 'session_ended';
  data: Record<string, unknown>;
  ts: number;
};

export type WatchState = {
  session: string;
  status: string;
  topic: string;
  epoch: number;
  step: number;
  events: WatchEvent[];
  cursor: number;
};
