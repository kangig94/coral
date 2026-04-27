import { assertNever } from '../../infra/error-format.js';
import type { CoordinatorStatusFull } from '../../transport/http/coordinator/status.js';
import type { ShutdownResult } from '../../transport/http/coordinator/shutdown.js';
import { joinLines } from './primitives.js';

export function formatCoordinatorStatus(result: CoordinatorStatusFull): string {
  switch (result.status) {
    case 'ok':
      return joinLines([
        'Coordinator ok',
        `Version: ${result.health.version}`,
        `Uptime: ${result.health.uptimeMs}ms`,
        `Active: ${result.health.active}`,
        `Active jobs: ${result.health.activeJobs}`,
      ]);
    case 'not_running':
      return 'Coordinator not running';
    case 'shutting_down':
      return 'Coordinator shutting down';
    case 'unauthorized':
      return 'Coordinator unauthorized';
    default:
      return assertNever(result);
  }
}

export function formatShutdown(result: ShutdownResult): string {
  return result.ok ? 'Coordinator shutdown initiated' : `Shutdown failed: ${result.reason}`;
}
