import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

let linuxBootTimeSecondsCache: number | null | undefined;
let linuxClockTicksPerSecondCache: number | null | undefined;

function parseLinuxBootTimeSeconds(): number | null {
  if (linuxBootTimeSecondsCache !== undefined) {
    return linuxBootTimeSecondsCache;
  }

  try {
    const stat = readFileSync('/proc/stat', 'utf-8');
    const line = stat
      .split('\n')
      .find((entry) => entry.startsWith('btime '))
      ?.trim();
    if (!line) {
      linuxBootTimeSecondsCache = null;
      return linuxBootTimeSecondsCache;
    }

    const parsed = Number.parseInt(line.slice('btime '.length), 10);
    linuxBootTimeSecondsCache = Number.isFinite(parsed) ? parsed : null;
    return linuxBootTimeSecondsCache;
  } catch {
    linuxBootTimeSecondsCache = null;
    return linuxBootTimeSecondsCache;
  }
}

const DEFAULT_LINUX_CLOCK_TICKS_PER_SECOND = 100;

function parseLinuxClockTicksPerSecond(): number | null {
  if (linuxClockTicksPerSecondCache !== undefined) {
    return linuxClockTicksPerSecondCache;
  }

  if (process.env.CORAL_DISCOVERY_PROBE_CLK_TCK !== '1') {
    linuxClockTicksPerSecondCache = DEFAULT_LINUX_CLOCK_TICKS_PER_SECOND;
    return linuxClockTicksPerSecondCache;
  }

  try {
    const raw = execFileSync('getconf', ['CLK_TCK'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const parsed = Number.parseInt(raw, 10);
    linuxClockTicksPerSecondCache =
      Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LINUX_CLOCK_TICKS_PER_SECOND;
    return linuxClockTicksPerSecondCache;
  } catch {
    linuxClockTicksPerSecondCache = DEFAULT_LINUX_CLOCK_TICKS_PER_SECOND;
    return linuxClockTicksPerSecondCache;
  }
}

function probeLinuxProcessStartedAtSeconds(pid: number): number | null {
  const bootTimeSeconds = parseLinuxBootTimeSeconds();
  const clockTicksPerSecond = parseLinuxClockTicksPerSecond();
  if (bootTimeSeconds === null || clockTicksPerSecond === null) {
    return null;
  }

  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen === -1) {
      return null;
    }

    const fields = stat
      .slice(closeParen + 2)
      .trim()
      .split(/\s+/);
    const startTicks = Number.parseInt(fields[19] ?? '', 10);
    if (!Number.isFinite(startTicks) || startTicks < 0) {
      return null;
    }

    return Math.floor(bootTimeSeconds + startTicks / clockTicksPerSecond);
  } catch {
    return null;
  }
}

function probeMacProcessStartedAtSeconds(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!raw) {
      return null;
    }

    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
  } catch {
    return null;
  }
}

function probeWindowsProcessStartedAtSeconds(pid: number): number | null {
  try {
    const raw = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = raw.match(/CreationDate=(\d{14})\./);
    if (!match) {
      return null;
    }

    const value = match[1];
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(4, 6), 10) - 1;
    const day = Number.parseInt(value.slice(6, 8), 10);
    const hour = Number.parseInt(value.slice(8, 10), 10);
    const minute = Number.parseInt(value.slice(10, 12), 10);
    const second = Number.parseInt(value.slice(12, 14), 10);
    return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000);
  } catch {
    return null;
  }
}

export function probeProcessStartedAtSeconds(pid: number, platform = process.platform): number | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }

  if (platform === 'linux') {
    return probeLinuxProcessStartedAtSeconds(pid);
  }
  if (platform === 'darwin') {
    return probeMacProcessStartedAtSeconds(pid);
  }
  if (platform === 'win32') {
    return probeWindowsProcessStartedAtSeconds(pid);
  }
  return null;
}
