export type InterruptedAppServerReason = 'restart' | 'handoff';

export type RecoveredAppServerFinalizationReason = InterruptedAppServerReason | 'user_abort';

export type InterruptedProbeOutcome = 'verified' | 'missing' | 'unavailable' | 'waiting';
