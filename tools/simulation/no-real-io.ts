export type NoRealIoReport = {
  realKillCalls: number;
  realFetchCalls: number;
  violations: string[];
};

export type NoRealIoRegistration = {
  report: NoRealIoReport;
  release: () => void;
};

const activeNoRealIoReports = new Set<NoRealIoReport>();
const originalFetch = globalThis.fetch;
const originalProcessKill = process.kill;
let noRealIoInstalled = false;

function pushUniqueViolation(report: NoRealIoReport, message: string): void {
  report.violations.push(message);
}

function describeFetchCall(input: unknown, init?: RequestInit): string {
  let method = init?.method;
  let target = 'unknown';

  if (typeof input === 'string' || input instanceof URL) {
    target = String(input);
  } else if (typeof Request !== 'undefined' && input instanceof Request) {
    target = input.url;
    method ??= input.method;
  }

  return `fetch(${method ?? 'GET'} ${target})`;
}

function recordNoRealIoFetch(input: unknown, init?: RequestInit): void {
  const message = describeFetchCall(input, init);
  for (const report of activeNoRealIoReports) {
    report.realFetchCalls += 1;
    pushUniqueViolation(report, message);
  }
}

function recordNoRealIoKill(pid: number, signal?: NodeJS.Signals | number): void {
  const renderedSignal = signal ?? 'SIGTERM';
  const message = `process.kill(${pid}, ${renderedSignal})`;
  for (const report of activeNoRealIoReports) {
    report.realKillCalls += 1;
    pushUniqueViolation(report, message);
  }
}

function installNoRealIoMonitor(): void {
  if (noRealIoInstalled) {
    return;
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    recordNoRealIoFetch(input, init);
    throw new Error('Real fetch is disabled while SimulationWorld is active');
  }) as typeof globalThis.fetch;

  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    recordNoRealIoKill(pid, signal);
    return true;
  }) as typeof process.kill;

  noRealIoInstalled = true;
}

function restoreNoRealIoMonitorIfIdle(): void {
  if (!noRealIoInstalled || activeNoRealIoReports.size > 0) {
    return;
  }

  globalThis.fetch = originalFetch;
  process.kill = originalProcessKill;
  noRealIoInstalled = false;
}

export function acquireNoRealIoMonitor(): NoRealIoRegistration {
  const report: NoRealIoReport = {
    realKillCalls: 0,
    realFetchCalls: 0,
    violations: [],
  };
  activeNoRealIoReports.add(report);
  installNoRealIoMonitor();

  let released = false;
  return {
    report,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      activeNoRealIoReports.delete(report);
      restoreNoRealIoMonitorIfIdle();
    },
  };
}

export function cloneNoRealIoReport(report: NoRealIoReport): NoRealIoReport {
  return {
    realKillCalls: report.realKillCalls,
    realFetchCalls: report.realFetchCalls,
    violations: [...report.violations],
  };
}
