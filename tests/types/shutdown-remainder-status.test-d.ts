import type { BackendStatusFull } from '../../src/transport/http/backend/status.js';

type ShutdownRemainderStatus = Extract<BackendStatusFull, { status: 'recent_shutdown_remainder' }>;
type OperatorFacingSettlement = ShutdownRemainderStatus['record']['entries'][number]['settlement'];

declare const settlement: OperatorFacingSettlement;

void settlement.cause;
// @ts-expect-error persisted prose is absent from the status projection.
void settlement.detail;
// @ts-expect-error a rendered settlement has no top-level error message.
void settlement.message;
// @ts-expect-error a rendered settlement has no top-level stack.
void settlement.stack;

if (settlement.cause === 'rejected' || settlement.cause === 'aborted') {
  void settlement.error.name;
  void settlement.error.code;
  // @ts-expect-error the thrown fingerprint excludes the persisted message.
  void settlement.error.message;
  // @ts-expect-error the thrown fingerprint excludes the persisted stack.
  void settlement.error.stack;
  // @ts-expect-error the thrown fingerprint excludes the persisted cause chain.
  void settlement.error.cause;
}
