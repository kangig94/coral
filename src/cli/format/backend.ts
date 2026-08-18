import { assertNever } from '../../infra/error-format.js';
import type { RecoveryQuarantineEntry } from '../../recovery/quarantine.js';
import type { BackendHealth } from '../../transport/http/backend/health.js';
import type { BackendStatusFull } from '../../transport/http/backend/status.js';
import type { ShutdownResult } from '../../transport/http/backend/shutdown.js';
import type { RecoveryQuarantineClearResult } from '../../recovery/source-registry.js';

export const RECOVERY_REVISION_UNTIL_CLEARED = 'until-cleared';
export const RECOVERY_REVISION_FINGERPRINT_PREFIX = 'fingerprint:';

export function formatBackendStatus(result: BackendStatusFull): string {
  switch (result.status) {
    case 'ok':
      return formatRunningStatus(result.health);
    case 'not_running':
      return 'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.';
    case 'undecodable_record':
      // Deliberately not "not running": the record exists and could not be read, which says nothing about
      // whether a coordinator is serving. The remedy names the file because nothing in Coral rewrites it while
      // a coordinator is up — it is written once at startup — so an operator is the only party who can clear it.
      //
      // "Stop any running coordinator" cannot mean a coral-cli command here: `backend shutdown` itself refuses
      // on this exact condition, before it ever dials, because host/port/bootToken all live in the record it
      // could not read — so the only reachable exit is the operator finding and stopping the process directly.
      return [
        `Backend state is unknown: the coordinator discovery record could not be read (${result.reason}).`,
        'A coordinator may still be running; this is not a report that none is.',
        `Next step: no coral-cli command can stop a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete ${result.path} and run a coral-cli mutating command to relaunch.`,
      ].join('\n');
    case 'unreachable':
      // Deliberately not "not running": something answered at the recorded address, or the request to it did
      // not complete. Five call sites used to route here and to the not-running report alike, so an operator
      // whose coordinator returned a 500 was told it was stopped.
      //
      // `responded` distinguishes those two causes: only a received response proves anything is listening.
      return [
        `Backend state is unknown: the coordinator did not give a usable answer (${result.detail}).`,
        result.responded
          ? 'Something is listening at the recorded address; this is not a report that the backend stopped.'
          : 'The request to the recorded address never completed; this is not a report that the backend stopped, and nothing observed here says whether anything is listening.',
        'Next step: retry, and check the coordinator logs if it persists.',
      ].join('\n');
    case 'recent_failure': {
      const lines = ['Backend is not running after a recent coordinator failure.', `Phase: ${result.phase}`];
      if (result.setupError === undefined) {
        // Undocumented failures have no authored remediation, and their raw
        // message can carry provider payloads or credentials, so the log stays
        // the only place it is rendered.
        lines.push(
          'Next step: inspect the coordinator log, fix the reported cause, then retry a coral-cli mutating command to relaunch it.',
        );
      } else {
        lines.push(`Cause: ${result.setupError.userMessage} [code=${result.setupError.code}]`);
        lines.push(`Next step: ${result.setupError.remediation}`);
      }
      return lines.join('\n');
    }
    case 'shutting_down':
      return 'Backend shutting down';
    case 'unauthorized':
      return 'Backend unauthorized. The discovery record and daemon token disagree — run coral-cli backend shutdown, then retry to relaunch with a fresh token.';
    default:
      return assertNever(result);
  }
}

/**
 * The mirror of `formatBackendStatus`'s `undecodable_record` case, and it exists because it did not.
 *
 * `shutdownBackend` computes the same three-way disposition as `getBackendStatusFull`, and this function used
 * to render whatever token came back — so an operator who ran `backend shutdown` against an unreadable record
 * was told `Shutdown failed: discovery_record_corrupt_json`, while `backend status` explained the identical
 * condition in three lines. The disposition was split and then flattened one call before it reached a person.
 */
export function formatShutdown(result: ShutdownResult): string {
  if (result.ok) {
    return 'Backend shutdown initiated';
  }
  switch (result.reason) {
    case 'unreadable_record':
      return [
        `Shutdown not attempted: the coordinator discovery record could not be read (${result.detail ?? 'unknown'}).`,
        'A coordinator may still be running; this is not confirmation that one stopped.',
        // No coral-cli command reaches this: shutdown needs host/port/bootToken from the very record it just
        // failed to read, so the manual path is the only one that exists. `backend status` is named only for
        // the file's path, not as a command that can stop anything here.
        'Next step: no coral-cli command can dial a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete the record file (run coral-cli backend status to see its path) and run a coral-cli mutating command to relaunch.',
      ].join('\n');
    case 'unreachable':
      return [
        `Shutdown not confirmed: the request to the coordinator did not complete (${result.detail ?? 'unknown'}).`,
        'The coordinator may still be running and may still be serving; this is not a report that it stopped.',
        'Next step: run coral-cli backend status, then retry the shutdown.',
      ].join('\n');
    // Three separate observations, and the sentence has to be the one that was made. An earlier version of
    // this branch rendered them all as "nothing was listening on the coordinator socket", which was a claim
    // about a dial that only the third of them performs.
    case 'no_record':
      return 'Backend not running: no coordinator has recorded itself.';
    case 'recorded_process_absent':
      return `Backend not running: the recorded coordinator process (pid ${result.detail ?? 'unknown'}) is gone.`;
    case 'socket_refused':
      return 'Backend not running: the coordinator socket refused the connection.';
    case 'nested_child':
      return [
        'Shutdown refused: this nested Coral process cannot shut down its parent coordinator.',
        "Next step: return to the top-level Coral session and run 'coral-cli backend shutdown' there.",
      ].join('\n');
    case 'capability_rejected': {
      const pid = result.detail ?? 'unknown';
      // The 401 proves a coordinator answers at the recorded address and rejected our token; it proves nothing
      // about the pid beyond what was already known before this request was sent. `pidLiveness` carries that
      // prior observation, so the sentence claims only what was actually confirmed, not what the 401 implies.
      const whatRespondedMeans =
        result.pidLiveness === 'alive'
          ? `It is running (pid ${pid}) and did not accept the request, so no retry of this command will get in.`
          : `A coordinator is running at the recorded address and did not accept the request, so no retry of this command will get in — but the recorded pid (${pid}) was not independently confirmed alive, so do not act on the pid alone.`;
      const stopHint =
        result.pidLiveness === 'alive'
          ? 'or stop that pid directly'
          : 'or confirm with your process manager that the recorded pid is still the process serving that address before stopping it directly';
      return [
        "Shutdown refused: the coordinator rejected the boot token in this build's discovery record.",
        whatRespondedMeans,
        `Next step: run coral-cli backend status to see which build is answering; if it is not this one, shut it down from its own install, ${stopHint}.`,
      ].join('\n');
    }
    default:
      // The mechanism `formatBackendStatus` has and this function could not have while `reason` was `string`.
      // A new token now fails to compile here instead of falling through to a raw-token render.
      return assertNever(result.reason);
  }
}

export function formatRecoveryQuarantineList(entries: readonly RecoveryQuarantineEntry[]): string {
  if (entries.length === 0) {
    return 'Recovery quarantine is empty.';
  }

  const lines = [`Recovery quarantine (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}):`];
  for (const entry of entries) {
    lines.push(
      `- boundary=${JSON.stringify(entry.boundary)} key=${JSON.stringify(entry.subject.key)} revision=${JSON.stringify(formatRecoveryRevision(entry))} state=${entry.state} stage=${entry.stage}`,
      `  detected_at=${entry.detectedAt} updated_at=${entry.updatedAt}`,
    );
    if (entry.retry !== null) {
      lines.push(`  retry_owner=${JSON.stringify(entry.retry.owner)} retry_token=${JSON.stringify(entry.retry.token)}`);
    }
    if (entry.continuation !== null) {
      lines.push(
        `  continuation_kind=${JSON.stringify(entry.continuation.kind)} continuation_key=${JSON.stringify(entry.continuation.key)}`,
      );
    }
    lines.push(`  error=${JSON.stringify(entry.errorMessage)}`, `  detail=${JSON.stringify(entry.detail)}`);
  }
  return lines.join('\n');
}

export function formatRecoveryQuarantineClear(result: RecoveryQuarantineClearResult): string {
  const coordinate = `boundary=${JSON.stringify(result.boundary)} key=${JSON.stringify(result.key)} revision=${JSON.stringify(formatRecoveryRevisionValue(result.revision))}`;
  switch (result.disposition) {
    case 'advanced':
      return `Recovery quarantine resolved and removed: ${coordinate}`;
    case 'quarantined':
      return `Recovery retry failed again; the subject is still quarantined: ${coordinate}. Run coral-cli backend recovery-quarantine list to inspect the updated error.`;
    case 'continuation':
      return `Recovery retry made partial progress: ${coordinate}. Run coral-cli backend recovery-quarantine list to inspect the durable continuation; do not run clear again with this coordinate.`;
    default:
      return assertNever(result.disposition);
  }
}

function formatRecoveryRevision(entry: RecoveryQuarantineEntry): string {
  return entry.subject.revision.kind === 'fingerprint'
    ? formatRecoveryRevisionValue(entry.subject.revision.value)
    : RECOVERY_REVISION_UNTIL_CLEARED;
}

function formatRecoveryRevisionValue(revision: string | null): string {
  return revision === null ? RECOVERY_REVISION_UNTIL_CLEARED : `${RECOVERY_REVISION_FINGERPRINT_PREFIX}${revision}`;
}

type RunningHealth = Extract<BackendStatusFull, { status: 'ok' }>['health'];
type RuntimeComponent = BackendHealth['components'][number];
type DegradedReason = Extract<RuntimeComponent, { phase: 'degraded' }>['reason'];

function formatRunningStatus(health: RunningHealth): string {
  const componentLines: string[] = [];
  for (const component of health.components) {
    componentLines.push(...formatComponentLines(component));
  }

  const lines: string[] = [
    `Backend ${health.status}`,
    `Version: ${health.version}`,
    `Uptime: ${formatDuration(health.uptimeMs)}`,
    formatKernelLine(health.kernel),
    `System provider scope: ${formatSystemProviderScope(health.systemProviderScope)}`,
    '',
    'Runtime Components:',
    ...componentLines,
    '',
    `Active jobs: ${health.activeJobs}`,
  ];
  if (typeof health.queueDepth === 'number') {
    lines.push(`Queue depth: ${health.queueDepth}`);
  }
  return lines.join('\n');
}

function formatSystemProviderScope(scope: RunningHealth['systemProviderScope']): string {
  if (scope === undefined) return 'unconfigured';
  return `${scope.name} (${scope.providers.join(', ')})`;
}

function formatKernelLine(kernel: RunningHealth['kernel']): string {
  if (kernel.readyAt === null) return `Kernel: ${kernel.phase}`;
  return `Kernel: ${kernel.phase} since ${new Date(kernel.readyAt).toISOString()}`;
}

function formatComponentLines(component: RuntimeComponent): string[] {
  const head = `  ${component.id}: ${component.phase}`;
  switch (component.phase) {
    case 'online':
      return [head];
    case 'initializing':
      return [head, `    attempt: ${component.attempt}`];
    case 'degraded': {
      const lines = [head, `    reason: ${component.reason.kind} (${formatDegradedDetail(component.reason)})`];
      if (component.reason.lastError) {
        lines.push(`    last error: ${component.reason.lastError}`);
      }
      lines.push(`    hint: ${formatDegradedHint(component.reason)}`);
      return lines;
    }
    case 'offline': {
      const lines = [head, `    reason: ${component.reason}`];
      if (component.lastLogLine) {
        lines.push(`    last log: ${component.lastLogLine}`);
      }
      if (component.diagnostic?.failedStep) {
        lines.push(`    failed step: ${component.diagnostic.failedStep}`);
      }
      if (typeof component.diagnostic?.attempts === 'number') {
        lines.push(`    attempts: ${component.diagnostic.attempts}`);
      }
      if (component.diagnostic?.retry) {
        lines.push(`    retry: ${formatOfflineRetry(component.diagnostic.retry)}`);
      }
      lines.push(`    hint: ${formatOfflineHint(component.diagnostic?.retry)}`);
      return lines;
    }
    default:
      return assertNever(component);
  }
}

function formatOfflineRetry(retry: 'restart-daemon' | 'none'): string {
  switch (retry) {
    case 'restart-daemon':
      return 'daemon restart required';
    case 'none':
      return 'not retryable';
    default:
      return assertNever(retry);
  }
}

function formatOfflineHint(retry: 'restart-daemon' | 'none' | undefined): string {
  if (retry === 'none') {
    return 'review the failure details above; coral-cli kb reindex can rebuild a corrupt KB index';
  }
  return 'restart the daemon: coral-cli backend shutdown';
}

function formatDegradedDetail(reason: DegradedReason): string {
  switch (reason.kind) {
    case 'curate-publish':
      return `${reason.consecutiveFailures} consecutive failures`;
    case 'recovery-quarantine':
      return `${reason.count} unresolved ${reason.count === 1 ? 'row' : 'rows'}`;
    default:
      return assertNever(reason);
  }
}

function formatDegradedHint(reason: DegradedReason): string {
  switch (reason.kind) {
    case 'curate-publish':
      return 'free disk space, then coral-cli backend shutdown to reset';
    case 'recovery-quarantine':
      return 'inspect quarantined recovery work: coral-cli backend recovery-quarantine list';
    default:
      return assertNever(reason);
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
