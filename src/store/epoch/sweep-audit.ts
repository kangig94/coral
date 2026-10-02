import { writeAuditEvent } from '../../infra/audit-log.js';

export function auditSweepFailure(path: string, error: unknown): void {
  writeAuditEvent(
    'store_epoch_sweep_failed',
    { path, cause: error instanceof Error ? error.message : String(error) },
    'warn',
  );
}

export function auditSweepSkip(path: string): void {
  writeAuditEvent('store_epoch_sweep_skipped', { path, reason: 'live-holder' }, 'info');
}
