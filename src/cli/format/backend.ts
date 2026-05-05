import { assertNever } from '../../infra/error-format.js';
import type { BackendHealth } from '../../transport/http/backend/health.js';
import type { BackendStatusFull } from '../../transport/http/backend/status.js';
import type { ShutdownResult } from '../../transport/http/backend/shutdown.js';

export function formatBackendStatus(result: BackendStatusFull): string {
  switch (result.status) {
    case 'ok':
      return formatRunningStatus(result.health);
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

type RunningHealth = Extract<BackendStatusFull, { status: 'ok' }>['health'];
type Subsystem = BackendHealth['subsystems'][number];
type DegradedReason = Extract<Subsystem, { phase: 'degraded' }>['reason'];

function formatRunningStatus(health: RunningHealth): string {
  const subsystemLines: string[] = [];
  for (const subsystem of health.subsystems) {
    subsystemLines.push(...formatSubsystemLines(subsystem));
  }

  const lines: string[] = [
    `Backend ${health.status}`,
    `Version: ${health.version}`,
    `Uptime: ${formatDuration(health.uptimeMs)}`,
    formatKernelLine(health.kernel),
    '',
    'Subsystems:',
    ...subsystemLines,
    '',
    `Active jobs: ${health.activeJobs}`,
  ];
  if (typeof health.queueDepth === 'number') {
    lines.push(`Queue depth: ${health.queueDepth}`);
  }
  return lines.join('\n');
}

function formatKernelLine(kernel: RunningHealth['kernel']): string {
  if (kernel.readyAt === null) return `Kernel: ${kernel.phase}`;
  return `Kernel: ${kernel.phase} since ${new Date(kernel.readyAt).toISOString()}`;
}

function formatSubsystemLines(subsystem: Subsystem): string[] {
  const head = `  ${subsystem.id}: ${subsystem.phase}`;
  switch (subsystem.phase) {
    case 'online':
      return [head];
    case 'initializing':
      return [head, `    attempt: ${subsystem.attempt}`];
    case 'degraded': {
      const lines = [head, `    reason: ${subsystem.reason.kind} (${formatDegradedDetail(subsystem.reason)})`];
      if (subsystem.reason.lastError) {
        lines.push(`    last error: ${subsystem.reason.lastError}`);
      }
      lines.push(`    hint: ${formatDegradedHint(subsystem.reason)}`);
      return lines;
    }
    case 'offline': {
      const lines = [head, `    reason: ${subsystem.reason}`];
      if (subsystem.lastLogLine) {
        lines.push(`    last log: ${subsystem.lastLogLine}`);
      }
      lines.push('    hint: coral-cli backend shutdown');
      return lines;
    }
    default:
      return assertNever(subsystem);
  }
}

function formatDegradedDetail(reason: DegradedReason): string {
  switch (reason.kind) {
    case 'curate-publish':
      return `${reason.consecutiveFailures} consecutive failures`;
    default:
      return assertNever(reason.kind);
  }
}

function formatDegradedHint(reason: DegradedReason): string {
  switch (reason.kind) {
    case 'curate-publish':
      return 'free disk space, then coral-cli backend shutdown to reset';
    default:
      return assertNever(reason.kind);
  }
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}
