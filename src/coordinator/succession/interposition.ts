/**
 * Named points of the succession protocol where a test harness may interpose. Production composes
 * `NO_SUCCESSION_INTERPOSITION`, so every point proceeds at once and nothing here is reachable from ambient state.
 */
export type SuccessionInterpositionPoint =
  | 'successor-writer-fence'
  | 'successor-committed-open'
  | 'successor-retirement-mint'
  | 'successor-retirement-generation'
  | 'successor-before-serving'
  | 'successor-serving-acknowledgment'
  | 'retirement-protection'
  | 'retirement-authorization'
  | 'incumbent-release'
  | 'incumbent-reclaim';

export type SuccessionInterpositionContext = Readonly<{ recovery: boolean }>;

/** A point fails the operation it guards by throwing, exactly as that operation's own failure would. */
export type SuccessionInterposition = Readonly<{
  at(point: SuccessionInterpositionPoint, context: SuccessionInterpositionContext): void | Promise<void>;
}>;

export const NO_SUCCESSION_INTERPOSITION: SuccessionInterposition = { at: () => undefined };
