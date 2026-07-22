import type { ProviderServerHandle } from '../provider-server-transport.js';
import type { TimePort } from '../../../infra/port-types.js';
import type { Runtime } from '../../../runtime/ports.js';
import { activePinCount } from './lease.js';
import type { HostStatsState, ProviderHostEntry } from './state.js';

const DEFAULT_BROKER_IDLE_MS = 300_000;

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

function usesHostStats(entry: ProviderHostEntry): boolean {
  return entry.spec.leaseMode === 'shared' && entry.spec.idlePolicy === 'host-stats';
}

function hasDaemonLifetime(entry: ProviderHostEntry): boolean {
  return entry.spec.leaseMode === 'shared' && entry.spec.idlePolicy === 'daemon';
}

function isHostIdleFromStats(entry: ProviderHostEntry): boolean {
  const hostStats = entry.hostStats;
  return hostStats !== null && hostStats.liveControllers === 0 && hostStats.activeTurns === 0;
}

function canCloseIdleHost(entry: ProviderHostEntry, entries: Map<string, ProviderHostEntry>): boolean {
  if (entry.closingError || entries.get(entry.hostKey) !== entry || !entry.handle) {
    return false;
  }
  if (activePinCount(entry) > 0) {
    return false;
  }
  if (hasDaemonLifetime(entry)) {
    return false;
  }
  if (usesHostStats(entry)) {
    return isHostIdleFromStats(entry);
  }
  return true;
}

export function maybeArmIdleTimer(
  entry: ProviderHostEntry,
  options: {
    runtime: Pick<Runtime, 'time'>;
    idleTimeoutMs: number;
    entries: Map<string, ProviderHostEntry>;
    closeProviderServerEntry: (entry: ProviderHostEntry, detail: string) => Promise<void>;
  },
): void {
  if (!entry.handle || entry.closingError) {
    return;
  }
  if (activePinCount(entry) > 0) {
    return;
  }
  if (hasDaemonLifetime(entry)) {
    clearIdleTimer(entry, options.runtime.time);
    return;
  }
  if (usesHostStats(entry) && !isHostIdleFromStats(entry)) {
    return;
  }

  clearIdleTimer(entry, options.runtime.time);
  entry.idleTimer = options.runtime.time.setTimeout(() => {
    entry.idleTimer = null;
    if (!canCloseIdleHost(entry, options.entries)) {
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
    closeProviderServerEntry: (entry: ProviderHostEntry, detail: string) => Promise<void>;
  },
): void {
  entry.disposeHostNotifications?.();
  entry.disposeHostNotifications = null;

  if (!usesHostStats(entry)) {
    entry.hostStats = null;
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
