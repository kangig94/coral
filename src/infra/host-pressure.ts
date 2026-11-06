import { backendLog } from './backend-log.js';
import { gracefulKill } from './process-supervision.js';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { ChildProcessLike, EnvPort, TimePort, TimerHandle } from './port-types.js';

export type HostPressure =
  | Readonly<{ kind: 'calm' }>
  | Readonly<{ kind: 'pressured'; signal: 'memory' | 'io'; reading: string }>
  | Readonly<{ kind: 'unobservable'; reason: string }>;

const MEMORY_FULL_AVG10_THRESHOLD = 10;
const IO_FULL_AVG10_THRESHOLD = 10;

export function classifyPsi(signal: 'memory' | 'io', text: string | null): HostPressure {
  const lines = text?.split('\n').filter((line) => /^full\s/.test(line)) ?? [];
  const match =
    lines.length === 1
      ? /^full\s+avg10=(\d+(?:\.\d+)?)\s+avg60=\d+(?:\.\d+)?\s+avg300=\d+(?:\.\d+)?\s+total=\d+\s*$/.exec(lines[0])
      : null;
  if (match === null || Number(match[1]) > 100)
    return { kind: 'unobservable', reason: `${signal} PSI missing or malformed` };
  const value = Number(match[1]);
  const threshold = signal === 'memory' ? MEMORY_FULL_AVG10_THRESHOLD : IO_FULL_AVG10_THRESHOLD;
  return value >= threshold ? { kind: 'pressured', signal, reading: `full avg10=${match[1]}` } : { kind: 'calm' };
}

export function classifyMacPressure(text: string | null): HostPressure {
  if (text === null || !/^\d+$/.test(text.trim()))
    return { kind: 'unobservable', reason: 'memory sysctl missing or malformed' };
  const level = Number(text.trim());
  if (!Number.isSafeInteger(level)) return { kind: 'unobservable', reason: 'memory sysctl malformed' };
  return level >= 2 ? { kind: 'pressured', signal: 'memory', reading: `level=${level}` } : { kind: 'calm' };
}

export function combineHostPressure(signals: readonly HostPressure[]): HostPressure {
  const pressured = signals.find((signal) => signal.kind === 'pressured');
  if (pressured !== undefined) return pressured;
  const reasons = signals.flatMap((signal) => (signal.kind === 'unobservable' ? [signal.reason] : []));
  return reasons.length > 0 ? { kind: 'unobservable', reason: reasons.join('; ') } : { kind: 'calm' };
}

export interface HostPressureMonitor {
  read(): HostPressure;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

const PRESSURE_FRESHNESS_MS = 10_000;
const PRESSURE_PROBE_TIMEOUT_MS = 1_000;

async function observeHostPressure(
  platform: NodeJS.Platform,
  signal: AbortSignal,
  accept: (reading: HostPressure) => void,
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>,
): Promise<HostPressure> {
  if (platform === 'linux') {
    const readings: HostPressure[] = [
      { kind: 'unobservable', reason: 'memory PSI pending' },
      { kind: 'unobservable', reason: 'io PSI pending' },
    ];
    await Promise.all(
      (['memory', 'io'] as const).map(async (resource, index) => {
        const text = await readFile(`/proc/pressure/${resource}`, { encoding: 'utf-8', signal }).catch(() => null);
        readings[index] = classifyPsi(resource, text);
        accept(combineHostPressure(readings));
      }),
    );
    return combineHostPressure(readings);
  }
  if (platform === 'darwin') {
    return new Promise((resolve) => {
      let reading: HostPressure = { kind: 'unobservable', reason: 'memory sysctl unavailable' };
      let terminating = false;
      const child = execFile(
        '/usr/sbin/sysctl',
        ['-n', 'kern.memorystatus_vm_pressure_level'],
        { encoding: 'utf-8', maxBuffer: 1024 },
        (error, stdout) => {
          if (error === null) reading = classifyMacPressure(stdout);
        },
      );
      const terminate = (): void => {
        if (terminating || child.exitCode !== null || child.signalCode !== null) return;
        terminating = true;
        void gracefulKill(child as ChildProcessLike, { time }, () =>
          child.exitCode === null && child.signalCode === null ? 'alive' : 'absent',
        );
      };
      child.on('close', () => {
        signal.removeEventListener('abort', terminate);
        resolve(reading);
      });
      signal.addEventListener('abort', terminate, { once: true });
      if (signal.aborted) terminate();
    });
  }
  return { kind: 'unobservable', reason: `unsupported platform: ${platform}` };
}

export function createHostPressureMonitor(
  platform: NodeJS.Platform,
  time: Pick<TimePort, 'monotonicNow' | 'setTimeout' | 'clearTimeout'>,
  env: Pick<EnvPort, 'get'>,
): HostPressureMonitor {
  const mode = env.get('CORAL_HOST_PRESSURE');
  if (mode === 'ignore') {
    return {
      read: () => ({ kind: 'unobservable', reason: 'ignored' }),
      refresh: async () => {},
      stop: async () => {},
    };
  }
  if (mode !== undefined && mode !== 'observe') {
    backendLog.warn('Invalid CORAL_HOST_PRESSURE; expected "observe" or "ignore". Using "observe".');
  }
  let observation: HostPressure = { kind: 'unobservable', reason: 'not sampled' };
  let observedAt: number | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let observationTask: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let deadline: TimerHandle | null = null;
  let finishRefresh: (() => void) | null = null;

  return {
    read: () => {
      if (stopped) return { kind: 'unobservable', reason: 'pressure monitor stopped' };
      if (observedAt === null) return observation;
      if (Number(time.monotonicNow()) - observedAt >= PRESSURE_FRESHNESS_MS) {
        return { kind: 'unobservable', reason: 'pressure observation stale' };
      }
      return observation;
    },
    refresh: () => {
      if (stopped) return Promise.resolve();
      if (inFlight !== null) return inFlight;
      const startedAt = Number(time.monotonicNow());
      let latest: HostPressure = { kind: 'unobservable', reason: 'pressure probe pending' };
      const probe = new AbortController();
      controller = probe;
      inFlight = new Promise<void>((resolve) => {
        finishRefresh = resolve;
      });
      const pending = inFlight;
      deadline = time.setTimeout(() => {
        deadline = null;
        observation =
          latest.kind === 'pressured' ? latest : { kind: 'unobservable', reason: 'pressure probe timed out' };
        observedAt = startedAt;
        probe.abort();
        finishRefresh?.();
      }, PRESSURE_PROBE_TIMEOUT_MS);
      deadline.unref?.();
      observationTask = observeHostPressure(
        platform,
        probe.signal,
        (reading) => {
          if (stopped || probe.signal.aborted) return;
          latest = reading;
          observation = reading;
          observedAt = startedAt;
        },
        time,
      )
        .then((reading) => {
          if (stopped || probe.signal.aborted) return;
          observation = reading;
          observedAt = startedAt;
        })
        .catch(() => {
          if (!stopped && !probe.signal.aborted) {
            observation = { kind: 'unobservable', reason: 'pressure probe failed' };
            observedAt = null;
          }
        })
        .finally(() => {
          if (deadline !== null) time.clearTimeout(deadline);
          deadline = null;
          controller = null;
          inFlight = null;
          observationTask = null;
          finishRefresh?.();
          finishRefresh = null;
        });
      return pending;
    },
    stop: () => {
      stopped = true;
      if (deadline !== null) time.clearTimeout(deadline);
      deadline = null;
      controller?.abort();
      finishRefresh?.();
      return platform === 'darwin' ? (observationTask ?? Promise.resolve()) : Promise.resolve();
    },
  };
}
