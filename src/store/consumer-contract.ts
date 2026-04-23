export type ConsumerRegistrationKind = 'base' | 'equipment';

export interface ConsumerApplyError {
  readonly message: string;
  readonly at: string;
  readonly cause?: unknown;
}
