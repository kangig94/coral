import type { ProviderServerHandle } from '../../../providers/app-server-transport.js';
import type { TimePort } from '../../../infra/port-types.js';
import type { Runtime } from '../../../runtime/ports.js';
import type { HostRef } from '../../../providers/contract.js';
import { backendLog } from '../../../infra/backend-log.js';
import { activePinCount } from './lease.js';
import { hostRefFromEntry, type HostStatsState, type ProviderHostEntry, type ProviderHostPin } from './state.js';

const DEFAULT_BROKER_IDLE_MS = 300_000;
const MIN_OUTSTANDING_PIN_DIAGNOSTIC_MS = 1_000;

export function parseIdleTimeoutMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_BROKER_IDLE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return DEFAULT_BROKER_IDLE_MS;
  }
  return parsed;
}

function readHostStats(params: Record<string, unknown> | undefined): HostStatsState | null {
  if (!params) {
    return null;
  }
  const liveControllers = params.liveControllers;
  const activeTurns = params.activeTurns;
  if (
    typeof liveControllers !== 'number' ||
    !Number.isFinite(liveControllers) ||
    liveControllers < 0 ||
    typeof activeTurns !== 'number' ||
    !Number.isFinite(activeTurns) ||
    activeTurns < 0
  ) {
    return null;
  }
  return {
    liveControllers,
    activeTurns,
  };
}

export function clearIdleTimer(entry: ProviderHostEntry, time: Pick<TimePort, 'clearTimeout'>): void {
  if (!entry.idleTimer) {
    return;
  }
  time.clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

function retiresOnHostReport(entry: ProviderHostEntry): boolean {
  return entry.spec.leaseMode === 'shared' && entry.spec.idleRetirement === 'unleased-and-host-idle';
}

function neverRetiresWhenIdle(entry: ProviderHostEntry): boolean {
  return entry.spec.leaseMode === 'shared' && entry.spec.idleRetirement === 'never';
}

function isHostIdleFromStats(entry: ProviderHostEntry): boolean {
  const hostStats = entry.hostStats;
  return hostStats !== null && hostStats.liveControllers === 0 && hostStats.activeTurns === 0;
}

function describePinOrigin(pin: ProviderHostPin): string {
  if (pin.kind === 'attached-session') {
    return 'origin.kind=attached-session, origin.jobId=none (attached session, no job)';
  }
  return `origin.kind=acquisition, origin.jobId=${pin.jobId ?? 'none (acquisition pin without a job id)'}`;
}

function logOutstandingPinsWithoutLiveCodexJob(
  entry: ProviderHostEntry,
  carrierBlocksRetirement: (hostRef: HostRef) => boolean,
): 'reported' | 'live-job' {
  let hostRef: HostRef;
  try {
    hostRef = hostRefFromEntry(entry);
    if (carrierBlocksRetirement(hostRef)) return 'live-job';
  } catch {
    return 'live-job';
  }

  for (const pin of entry.pins.values()) {
    backendLog.warn(
      `Provider host ${hostRef.provider} ${hostRef.instanceId} (${entry.spec.cwd}) has an outstanding pin while no live Codex job owns it: ${describePinOrigin(pin)}`,
    );
  }
  return 'reported';
}

function armOutstandingPinDiagnostic(
  entry: ProviderHostEntry,
  options: {
    runtime: Pick<Runtime, 'time'>;
    idleTimeoutMs: number;
    carrierBlocksRetirement: (hostRef: HostRef) => boolean;
  },
): void {
  clearIdleTimer(entry, options.runtime.time);
  entry.idleTimer = options.runtime.time.setTimeout(
    () => {
      entry.idleTimer = null;
      if (!entry.handle || entry.closingError || activePinCount(entry) === 0) return;
      if (logOutstandingPinsWithoutLiveCodexJob(entry, options.carrierBlocksRetirement) === 'reported') return;
      armOutstandingPinDiagnostic(entry, options);
    },
    Math.max(options.idleTimeoutMs, MIN_OUTSTANDING_PIN_DIAGNOSTIC_MS),
  );
  entry.idleTimer.unref?.();
}

function canCloseIdleHost(
  entry: ProviderHostEntry,
  entries: Map<string, ProviderHostEntry>,
  carrierBlocksRetirement: (hostRef: HostRef) => boolean,
): boolean {
  if (entry.closingError || entries.get(entry.hostKey) !== entry || !entry.handle) {
    return false;
  }
  if (activePinCount(entry) > 0) {
    return false;
  }
  if (neverRetiresWhenIdle(entry)) {
    return false;
  }
  if (retiresOnHostReport(entry)) {
    if (!isHostIdleFromStats(entry)) return false;
  }
  try {
    return !carrierBlocksRetirement(hostRefFromEntry(entry));
  } catch {
    return false;
  }
}

export function maybeArmIdleTimer(
  entry: ProviderHostEntry,
  options: {
    runtime: Pick<Runtime, 'time'>;
    idleTimeoutMs: number;
    entries: Map<string, ProviderHostEntry>;
    carrierBlocksRetirement: (hostRef: HostRef) => boolean;
    closeProviderServerEntry: (entry: ProviderHostEntry, detail: string) => Promise<void>;
  },
): void {
  if (!entry.handle || entry.closingError) {
    return;
  }
  if (activePinCount(entry) > 0) {
    if (entry.spec.provider === 'codex') {
      armOutstandingPinDiagnostic(entry, options);
    }
    return;
  }
  if (neverRetiresWhenIdle(entry)) {
    clearIdleTimer(entry, options.runtime.time);
    return;
  }
  if (retiresOnHostReport(entry) && !isHostIdleFromStats(entry)) {
    return;
  }

  clearIdleTimer(entry, options.runtime.time);
  if (!canCloseIdleHost(entry, options.entries, options.carrierBlocksRetirement)) {
    return;
  }
  entry.idleTimer = options.runtime.time.setTimeout(() => {
    entry.idleTimer = null;
    if (!canCloseIdleHost(entry, options.entries, options.carrierBlocksRetirement)) {
      return;
    }
    void options.closeProviderServerEntry(entry, 'idle timeout expired').catch(() => {});
  }, options.idleTimeoutMs);
  entry.idleTimer.unref?.();
}

export function attachHostNotificationListener(
  entry: ProviderHostEntry,
  handle: ProviderServerHandle,
  options: {
    runtime: Pick<Runtime, 'time'>;
    idleTimeoutMs: number;
    entries: Map<string, ProviderHostEntry>;
    carrierBlocksRetirement: (hostRef: HostRef) => boolean;
    closeProviderServerEntry: (entry: ProviderHostEntry, detail: string) => Promise<void>;
  },
): void {
  entry.disposeHostNotifications?.();
  entry.disposeHostNotifications = null;

  if (!retiresOnHostReport(entry)) {
    entry.hostStats = null;
    maybeArmIdleTimer(entry, options);
    return;
  }

  // Unknown is not idle. A shared host becomes eligible only after it has
  // explicitly reported a zero/zero snapshot.
  entry.hostStats = null;
  entry.disposeHostNotifications = handle.onNotification((message) => {
    if (typeof message?.method !== 'string') {
      return;
    }
    if (message.method !== 'host/stats') return;

    const stats = readHostStats(message.params);
    if (!stats) {
      return;
    }
    entry.hostStats = stats;
    clearIdleTimer(entry, options.runtime.time);
    maybeArmIdleTimer(entry, options);
  });

  maybeArmIdleTimer(entry, options);
}
