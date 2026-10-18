export type InterruptedAppServerReason = 'restart' | 'handoff';

export type RecoveredAppServerFinalizationReason = InterruptedAppServerReason | 'user_abort';
