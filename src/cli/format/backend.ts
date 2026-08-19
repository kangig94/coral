import { assertNever } from '../../infra/error-format.js';
import type { RecoveryQuarantineEntry } from '../../recovery/quarantine.js';
import type { BackendHealth } from '../../transport/http/backend/health.js';
import type { BackendStatusFull } from '../../transport/http/backend/status.js';
import type { ShutdownResult } from '../../transport/http/backend/shutdown.js';
import type { RecoveryQuarantineClearResult } from '../../recovery/source-registry.js';

export const RECOVERY_REVISION_UNTIL_CLEARED = 'until-cleared';
export const RECOVERY_REVISION_FINGERPRINT_PREFIX = 'fingerprint:';

// Shared by every shutdown disposition this run could not resolve either way: none of them may tell an
// operator to do anything but ask again.
const SHUTDOWN_RETRY_NEXT_STEP = 'Next step: run coral-cli backend status, then retry the shutdown.';

export function formatBackendStatus(result: BackendStatusFull): string {
  switch (result.status) {
    case 'ok':
      return formatRunningStatus(result.health);
    case 'not_running':
      return 'Backend not running. Any coral-cli mutating command (or a Claude Code session start) relaunches it.';
    case 'undecodable_record':
      return formatUndecodableRecordStatus(result);
    case 'unreachable':
      return formatUnreachableStatus(result);
    case 'no_record_socket_present':
      return formatNoRecordSocketPresentStatus(result);
    case 'recent_failure':
      return formatRecentFailureStatus(result);
    case 'shutting_down':
      return 'Backend shutting down';
    case 'unauthorized':
      return 'Backend unauthorized. The discovery record and daemon token disagree — run coral-cli backend shutdown, then retry to relaunch with a fresh token.';
    default:
      return assertNever(result);
  }
}

// Deliberately not "not running": the record exists and could not be read, which says nothing about whether a
// coordinator is serving. The remedy names the file because nothing in Coral rewrites it while a coordinator is
// up — it is written once at startup — so an operator is the only party who can clear it.
//
// The remedy is the operator rather than a coral-cli command because every command that could stop a
// coordinator needs its host, port and boot token, and all three live in the record this status exists to
// report unreadable. Nothing that reads them can act while it cannot be read.
function formatUndecodableRecordStatus(result: Extract<BackendStatusFull, { status: 'undecodable_record' }>): string {
  return [
    `Backend state is unknown: the coordinator discovery record could not be read (${result.reason}).`,
    'A coordinator may still be running; this is not a report that none is.',
    `Next step: no coral-cli command can stop a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete ${result.path} and run a coral-cli mutating command to relaunch.`,
  ].join('\n');
}

// Deliberately not "not running": something answered at the recorded address, the address refused a
// connection, or the request to it did not complete. `cause` distinguishes those three, since only a received
// response proves anything is listening and only a refusal proves nothing is.
function formatUnreachableStatus(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  return [
    `Backend state is unknown: the coordinator did not give a usable answer (${result.detail}).`,
    formatUnreachableCauseLine(result),
    formatUnreachableNextStep(result),
  ].join('\n');
}

function formatUnreachableCauseLine(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  switch (result.cause) {
    case 'responded':
      return 'Something is listening at the recorded address; this is not a report that the backend stopped.';
    case 'refused':
      return result.pidLiveness === 'alive'
        ? "Nothing is listening at the recorded address, though the recorded pid still belongs to a running process — a coordinator's HTTP listener can close before that process finishes shutting down, and a reused pid looks the same from here, so this alone does not mean the backend stopped."
        : 'Nothing is listening at the recorded address, and the recorded process could not be independently confirmed alive or gone before this request was sent.';
    case 'no_response':
      return 'The request to the recorded address never completed; this is not a report that the backend stopped, and nothing observed here says whether anything is listening.';
    default:
      return assertNever(result);
  }
}

// `refused` is the one cause here `backend shutdown` already resolves for the identical evidence
// (`formatSocketRefused`): a reused pid never clears by retrying, so this arm names the same check-and-clear
// remedy instead of leaving an operator to retry a hold that cannot end that way.
function formatUnreachableNextStep(result: Extract<BackendStatusFull, { status: 'unreachable' }>): string {
  switch (result.cause) {
    case 'responded':
    case 'no_response':
      return 'Next step: retry, and check the coordinator logs if it persists.';
    case 'refused':
      return `Next step: retry shortly — a drain finishes on its own. If it keeps refusing, the record may name a pid something else now holds: run 'ps -p ${result.pid}' (or check your process manager), and if that is not Coral, delete ${result.recordPath} and run a coral-cli mutating command to relaunch.`;
    default:
      return assertNever(result);
  }
}

// Not "not running": the coordinator's own IPC socket file exists, which a coordinator mid-boot and a stale
// socket a killed one left behind both produce, indistinguishably — see `CoordinatorObservation`'s
// `no-record-socket-present` for the mechanism.
function formatNoRecordSocketPresentStatus(
  result: Extract<BackendStatusFull, { status: 'no_record_socket_present' }>,
): string {
  return [
    'Backend state is unknown: the coordinator IPC socket exists, but no discovery record has been written yet.',
    `Socket: ${result.socketPath}`,
    'A coordinator may still be starting, or this may be a stale socket left by one that did not exit cleanly; this is not a report that the backend is running or that it has stopped.',
    'Next step: retry shortly — a coordinator mid-boot writes its record within seconds, and how long this persists does not by itself tell a stale socket from one still starting. Run a coral-cli mutating command (or start a Claude Code session) either way: it binds and relaunches if the socket was stale, or negotiates with a live coordinator there and may itself refuse with a Manual repair required error instead of relaunching — treat that refusal as the next thing to read, not as a reason to keep retrying.',
  ].join('\n');
}

function formatRecentFailureStatus(result: Extract<BackendStatusFull, { status: 'recent_failure' }>): string {
  const lines = ['Backend is not running after a recent coordinator failure.', `Phase: ${result.phase}`];
  if (result.setupError === undefined) {
    // Undocumented failures have no authored remediation, and their raw message can carry provider payloads or
    // credentials, so the log stays the only place it is rendered.
    lines.push(
      'Next step: inspect the coordinator log, fix the reported cause, then retry a coral-cli mutating command to relaunch it.',
    );
  } else {
    lines.push(`Cause: ${result.setupError.userMessage} [code=${result.setupError.code}]`);
    lines.push(`Next step: ${result.setupError.remediation}`);
  }
  return lines.join('\n');
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
    return result.alreadyDraining ? 'Backend shutdown already in progress' : 'Backend shutdown initiated';
  }
  switch (result.reason) {
    case 'unreadable_record':
      return formatUnreadableRecordShutdown(result.detail);
    case 'refused_by_response':
      return formatRefusedByResponse(result.detail);
    case 'no_response':
      return formatNoResponse(result.detail);
    // Three separate observations, and the sentence has to be the one that was made. An earlier version of
    // this branch rendered them all as "nothing was listening on the coordinator socket", which was a claim
    // about a dial that only `socket_refused` performs.
    case 'no_record':
      return 'Backend not running: no coordinator has recorded itself.';
    case 'recorded_process_absent':
      return `Backend not running: the recorded coordinator process (pid ${result.detail}) is gone.`;
    case 'socket_refused':
      return formatSocketRefused(result);
    case 'nested_child':
      return [
        'Shutdown refused: this nested Coral process cannot shut down its parent coordinator.',
        "Next step: return to the top-level Coral session and run 'coral-cli backend shutdown' there.",
      ].join('\n');
    case 'capability_rejected':
      return formatCapabilityRejected(result);
    case 'no_record_socket_present':
      return formatNoRecordSocketPresentShutdown();
    default:
      // The mechanism `formatBackendStatus` has and this function could not have while `reason` was `string`.
      // A new token now fails to compile here instead of falling through to a raw-token render.
      return assertNever(result);
  }
}

// No coral-cli command reaches this: shutdown needs host/port/bootToken from the very record it just failed to
// read, so the manual path is the only one that exists. `backend status` is named only for the file's path,
// not as a command that can stop anything here.
function formatUnreadableRecordShutdown(detail: string): string {
  return [
    `Shutdown not attempted: the coordinator discovery record could not be read (${detail}).`,
    'A coordinator may still be running; this is not confirmation that one stopped.',
    'Next step: no coral-cli command can dial a coordinator whose own record it cannot read. If one is running, find and stop that process yourself (ps, or your process manager), then delete the record file (run coral-cli backend status to see its path) and run a coral-cli mutating command to relaunch.',
  ].join('\n');
}

// A response arrived — the mirror of `formatUnreachableStatus`'s `'responded'` cause, and the same
// observation `getBackendStatusFull` makes of the identical HTTP exchange: something is listening.
function formatRefusedByResponse(detail: string): string {
  return [
    `Shutdown not confirmed: the coordinator responded but did not accept the request (${detail}).`,
    'Something is listening at the recorded address; this is not a report that it stopped.',
    SHUTDOWN_RETRY_NEXT_STEP,
  ].join('\n');
}

// No response ever arrived — the mirror of `formatUnreachableStatus`'s `'no_response'` cause: nothing here
// proves anything is listening, but nothing proves the opposite either.
function formatNoResponse(detail: string): string {
  return [
    `Shutdown not confirmed: the request to the coordinator did not complete (${detail}).`,
    'The coordinator may still be running and may still be serving; this is not a report that it stopped.',
    SHUTDOWN_RETRY_NEXT_STEP,
  ].join('\n');
}

// Mirrors `formatBackendStatus`'s `no_record_socket_present` case: the coordinator's own IPC socket exists
// with no record written yet, so a boot in progress and a stale leftover socket are equally possible.
function formatNoRecordSocketPresentShutdown(): string {
  return [
    'Shutdown not attempted: the coordinator IPC socket exists, but no discovery record has been written yet.',
    'A coordinator may still be starting, or this may be a stale socket left by one that did not exit cleanly; this is not a report that it stopped.',
    // Not `SHUTDOWN_RETRY_NEXT_STEP`: `backend status` is a read, so for a stale socket it reports this same
    // state forever and the two commands loop. Relaunching is what ends it — binding clears a stale socket.
    'Next step: retry shortly in case a coordinator is mid-boot — how long this persists does not by itself tell a stale socket from one still starting. Run a coral-cli mutating command (or start a Claude Code session) either way: it binds and relaunches if the socket was stale, or negotiates with a live coordinator there and may itself refuse with a Manual repair required error instead. Treat that refusal as the next thing to read; once it relaunches, retry the shutdown.',
  ].join('\n');
}

// A refused connection is never grounds for "not running" here: an absent pid is excluded before this request
// is ever sent (see `ShutdownResult`'s doc in shutdown.ts), so `pidLiveness` is always `'alive'` or `'unknown'`
// — and `'alive'` is the deterministic mid-drain window where the coordinator's HTTP listener has closed while
// the process keeps running. Neither case may claim the backend stopped.
//
// `'alive'` says the recorded pid still belongs to a running process, and nothing more: `observeProcessLiveness`
// is a bare `kill(pid, 0)` that counts `EPERM` as alive, so it cannot tell Coral's coordinator from whatever
// reused that number. That second reading is why retrying is not the only exit offered — a drain finishes on
// its own, a record naming a stranger's pid never does, and the two are indistinguishable from here.
function formatSocketRefused(result: Extract<ShutdownResult, { reason: 'socket_refused' }>): string {
  const whatRefusalMeans =
    result.pidLiveness === 'alive'
      ? `The recorded pid ${result.pid} still belongs to a running process, but the admin socket refused the connection — a coordinator's HTTP listener can close before the process finishes shutting down, so this alone does not mean the backend stopped.`
      : `The coordinator socket refused the connection, and the recorded process (pid ${result.pid}) could not be independently confirmed alive or gone before this request was sent.`;
  return [
    `Shutdown not confirmed: ${whatRefusalMeans}`,
    'The coordinator may still be running; this is not a report that it stopped.',
    `Next step: retry shortly — a drain finishes on its own. If it keeps refusing, the record may name a pid something else now holds: run 'ps -p ${result.pid}' (or check your process manager), and if that is not Coral, delete ${result.recordPath} and run a coral-cli mutating command to relaunch.`,
  ].join('\n');
}

// The 401 proves a coordinator answers at the recorded address and rejected our token; it proves nothing about
// the pid beyond what was already known before this request was sent. `pidLiveness` carries that prior
// observation, so the sentence claims only what was actually confirmed, not what the 401 implies.
function formatCapabilityRejected(result: Extract<ShutdownResult, { reason: 'capability_rejected' }>): string {
  const pid = result.detail;
  const whatRespondedMeans =
    result.pidLiveness === 'alive'
      ? `A coordinator is running at the recorded address and did not accept the request, so no retry of this command will get in — the recorded pid ${pid} still belongs to a running process, but a pid is reused, so that alone does not confirm it is this coordinator.`
      : `A coordinator is running at the recorded address and did not accept the request, so no retry of this command will get in — but the recorded pid (${pid}) was not independently confirmed alive, so do not act on the pid alone.`;
  return [
    "Shutdown refused: the coordinator rejected the boot token in this build's discovery record.",
    whatRespondedMeans,
    'Next step: run coral-cli backend status to see which build is answering; if it is not this one, shut it down from its own install, or confirm with your process manager that the recorded pid is still the process serving that address before stopping it directly.',
  ].join('\n');
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
