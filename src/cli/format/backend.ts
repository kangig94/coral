import { assertNever } from '../../infra/error-format.js';
import type { BackendStatusFull } from '../../transport/http/backend/status.js';
import type { ShutdownResult } from '../../transport/http/backend/shutdown.js';
import { joinLines } from './text.js';

export function formatBackendStatus(result: BackendStatusFull): string {
  switch (result.status) {
    case 'ok':
      return joinLines([
        'Backend ok',
        `Version: ${result.health.version}`,
        `Uptime: ${result.health.uptimeMs}ms`,
        `Active: ${result.health.active}`,
        `Active jobs: ${result.health.activeJobs}`,
      ]);
    case 'not_running':
      return 'Backend not running';
    case 'shutting_down':
      return 'Backend shutting down';
    case 'unauthorized':
      return 'Backend unauthorized';
    default:
      return assertNever(result);
  }
}

export function formatShutdown(result: ShutdownResult): string {
  return result.ok ? 'Backend shutdown initiated' : `Shutdown failed: ${result.reason}`;
}
