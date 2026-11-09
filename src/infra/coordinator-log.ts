import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

import { setBackendLogSink } from './backend-log.js';
import {
  observeProcessLiveness,
  probeProcessIncarnation,
  processIncarnationSchema,
  processIncarnationStartOrder,
  type ProcessIncarnation,
  type ProcessLiveness,
} from './node-process.js';
import type { EnvPort, StoragePort, TimePort, TimerHandle } from './port-types.js';

export const LOG_ROTATE_THRESHOLD_BYTES = 2 * 1024 * 1024;
export const COORDINATOR_NATIVE_STDERR_PATH = 'coordinator-logs/native-stderr.log';
const LOG_WRITERS_KEPT = 5;
const LOG_FAILED_WRITERS_KEPT = 10;
const LOG_RETENTION_INTERVAL_MS = 60_000;
const segmentFiles = ['current.log', 'current.log.1', 'segments-closed', 'writer.json', 'pointer.tmp'];
const roles = ['coordinator', 'supervisor'] as const;
type LogRole = (typeof roles)[number];
const writerSchema = z.object({
  version: z.literal(1),
  role: z.enum(roles),
  pid: z.number().int().positive(),
  incarnation: processIncarnationSchema,
});
type Writer = z.infer<typeof writerSchema>;

type CoordinatorLogStorage = Pick<
  StoragePort,
  | 'mkdirSync'
  | 'openSync'
  | 'closeSync'
  | 'writeSync'
  | 'renameSync'
  | 'readFileSync'
  | 'lstatSync'
  | 'statSync'
  | 'readdirSync'
  | 'unlinkSync'
  | 'rmdirSync'
  | 'writeFileSync'
  | 'appendFileSync'
>;

export type CoordinatorLogPorts = {
  storage: CoordinatorLogStorage;
  ids: { uuid(): string };
  env: Pick<EnvPort, 'pid' | 'platform'>;
  process: {
    readProcessIncarnation(pid: number, platform: NodeJS.Platform): ProcessIncarnation | null;
    observeLiveness(pid: number): ProcessLiveness;
  };
  time: Pick<TimePort, 'setInterval' | 'clearInterval'>;
};

const nodePorts: CoordinatorLogPorts = {
  storage: fs,
  ids: { uuid: randomUUID },
  env: { pid: () => process.pid, platform: () => process.platform },
  process: { readProcessIncarnation: probeProcessIncarnation, observeLiveness: observeProcessLiveness },
  time: {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => {
      if (handle !== null) clearInterval(handle as NodeJS.Timeout);
    },
  },
};

let currentLog: { role: LogRole; path: string } | undefined;

/** Discovery pointers must not substitute another process's log for this coordinator's diagnostics. */
export function getCoordinatorLogPath(): string | undefined {
  return currentLog?.role === 'coordinator' ? currentLog.path : undefined;
}

function incarnationDigest(incarnation: ProcessIncarnation): string {
  return createHash('sha256').update(incarnation).digest('hex');
}

function observeIncarnation(
  ports: CoordinatorLogPorts,
  pid: number,
): { kind: 'observed'; incarnation: ProcessIncarnation } | { kind: 'absent' | 'unknown' } {
  try {
    const incarnation = ports.process.readProcessIncarnation(pid, ports.env.platform() as NodeJS.Platform);
    if (incarnation !== null) return { kind: 'observed', incarnation };
    return { kind: ports.process.observeLiveness(pid) === 'absent' ? 'absent' : 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

function observeWriter(ports: CoordinatorLogPorts, writer: Writer): ProcessLiveness {
  const observed = observeIncarnation(ports, writer.pid);
  return observed.kind === 'observed'
    ? observed.incarnation === writer.incarnation
      ? 'alive'
      : 'absent'
    : observed.kind;
}

function readWriter(storage: CoordinatorLogStorage, directory: string): Writer | undefined {
  try {
    if (!storage.lstatSync(join(directory, 'writer.json')).isFile()) return undefined;
    const parsed = writerSchema.safeParse(JSON.parse(storage.readFileSync(join(directory, 'writer.json'), 'utf-8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function certifiedClosed(storage: CoordinatorLogStorage, directory: string): boolean {
  try {
    const certificate = join(directory, 'segments-closed');
    return (
      storage.lstatSync(certificate).isFile() && storage.readFileSync(certificate, 'utf-8') === basename(directory)
    );
  } catch {
    return false;
  }
}

function removeLogDirectory(storage: CoordinatorLogStorage, directory: string, names: readonly string[]): void {
  const present = storage.readdirSync(directory);
  if (present.some((name) => !names.includes(name))) return;
  for (const name of present) {
    try {
      storage.unlinkSync(join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
  }
  storage.rmdirSync(directory);
}

function pruneInterruptedPublication(ports: CoordinatorLogPorts, logsDir: string, name: string): void {
  const match = /^\.(stage|retiring)-(coordinator|supervisor)-(\d+)-([a-f0-9]{64})(?:-([a-f0-9-]{36}))?$/.exec(name);
  if (match === null) return;
  if (match[1] === 'stage' && match[5] !== undefined) return;
  if (match[1] === 'retiring' && match[5] === undefined) return;
  const directory = join(logsDir, name);
  if (!ports.storage.lstatSync(directory).isDirectory()) return;
  const pid = Number(match[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  const observed = observeIncarnation(ports, pid);
  const absent =
    observed.kind === 'absent' ||
    (observed.kind === 'observed' && incarnationDigest(observed.incarnation) !== match[4]);
  if (!absent) return;
  removeLogDirectory(ports.storage, directory, match[1] === 'stage' ? ['writer.json'] : segmentFiles);
}

function readRolePointerSelection(
  storage: CoordinatorLogStorage,
  logsDir: string,
  role: LogRole,
  path: string,
): 'selected' | 'not-selected' | 'unknown' {
  try {
    const pointer = JSON.parse(storage.readFileSync(join(logsDir, `latest-${role}.json`), 'utf-8')) as {
      path?: unknown;
      writer?: unknown;
    };
    const writer = writerSchema.safeParse(pointer.writer);
    if (!writer.success || writer.data.role !== role || typeof pointer.path !== 'string') return 'unknown';
    if (pointer.path !== join(logsDir, basename(dirname(pointer.path)), 'current.log')) return 'unknown';
    return pointer.path === path ? 'selected' : 'not-selected';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-selected' : 'unknown';
  }
}

type WriterNamespace = {
  id: string;
  writer: Writer;
  at: number;
  order: ReturnType<typeof processIncarnationStartOrder>;
};

function orderWriterNamespaces(
  entries: readonly WriterNamespace[],
  currentBoot: string | undefined,
): WriterNamespace[] {
  const groups = new Map<string, { key: string; at: number; entries: WriterNamespace[] }>();
  for (const entry of entries) {
    const key = entry.order === null ? `namespace:${entry.id}` : `boot:${entry.order.bootId}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { key, at: entry.at, entries: [entry] });
    else {
      group.at = Math.max(group.at, entry.at);
      group.entries.push(entry);
    }
  }
  return [...groups.values()]
    .sort((a, b) => {
      if (a.key === b.key) return 0;
      if (a.key === currentBoot) return -1;
      if (b.key === currentBoot) return 1;
      return b.at - a.at || a.key.localeCompare(b.key);
    })
    .flatMap((group) =>
      group.entries.sort((a, b) => {
        if (a.order !== null && b.order !== null && a.order.startTicks !== b.order.startTicks)
          return a.order.startTicks > b.order.startTicks ? -1 : 1;
        return b.at - a.at || a.id.localeCompare(b.id);
      }),
    );
}

function pruneLogs(ports: CoordinatorLogPorts, logsDir: string, incarnation: ProcessIncarnation): void {
  const { storage } = ports;
  const bootId = processIncarnationStartOrder(incarnation)?.bootId;
  const currentBoot = bootId === undefined ? undefined : `boot:${bootId}`;
  try {
    const candidates: WriterNamespace[] = [];
    for (const name of storage.readdirSync(logsDir)) {
      try {
        if (name.startsWith('.')) {
          pruneInterruptedPublication(ports, logsDir, name);
          continue;
        }
        if (!/^[a-f0-9-]{36}$/.test(name)) continue;
        const directory = join(logsDir, name);
        if (!storage.lstatSync(directory).isDirectory()) continue;
        const writer = readWriter(storage, directory);
        if (writer !== undefined)
          candidates.push({
            id: name,
            writer,
            at: storage.statSync(join(directory, 'writer.json')).mtimeMs,
            order: processIncarnationStartOrder(writer.incarnation),
          });
      } catch {
        continue;
      }
    }
    for (const role of roles) {
      const writers = orderWriterNamespaces(
        candidates.filter((entry) => entry.writer.role === role),
        currentBoot,
      );
      const clean = writers.filter((entry) => certifiedClosed(storage, join(logsDir, entry.id)));
      const failed = writers.filter(
        (entry) => !clean.includes(entry) && observeWriter(ports, entry.writer) === 'absent',
      );
      const cleanBoundary = writers.findIndex((entry) => clean.includes(entry));
      const currentRun = writers
        .slice(0, cleanBoundary === -1 ? writers.length : cleanBoundary)
        .filter((entry) => failed.includes(entry));
      const firstFailure = currentRun.at(-1) ?? failed[0];
      const kept = new Set([
        ...clean.slice(0, LOG_WRITERS_KEPT),
        ...failed.filter((entry) => entry !== firstFailure).slice(0, LOG_FAILED_WRITERS_KEPT - 1),
        ...(firstFailure === undefined ? [] : [firstFailure]),
      ]);
      for (const entry of writers) {
        if (kept.has(entry) || (!clean.includes(entry) && !failed.includes(entry))) continue;
        const directory = join(logsDir, entry.id);
        // Only this writer can publish its namespace, and closure or absence ends that publication authority.
        if (readRolePointerSelection(storage, logsDir, role, join(directory, 'current.log')) !== 'not-selected')
          continue;
        try {
          const names = storage.readdirSync(directory);
          if (names.some((name) => !segmentFiles.includes(name))) continue;
          const retiring = join(
            logsDir,
            `.retiring-${role}-${entry.writer.pid}-${incarnationDigest(entry.writer.incarnation)}-${entry.id}`,
          );
          storage.renameSync(directory, retiring);
          removeLogDirectory(storage, retiring, segmentFiles);
        } catch {
          continue;
        }
      }
    }
  } catch {
    // Retention failure cannot select a launch or recovery disposition.
  }
}

type LogWriter = { write(message: string): void; close(clean: boolean): void };

/** Node opens these private descriptors with O_CLOEXEC; they must never be passed in child stdio. */
function createLogWriter(storage: CoordinatorLogStorage, path: string, closed: (clean: boolean) => void): LogWriter {
  let fd: number | null = storage.openSync(path, 'wx', 0o600);
  let size = 0;
  let ended = false;
  function closeDescriptor(): void {
    if (fd === null) return;
    try {
      storage.closeSync(fd);
      fd = null;
    } catch (error) {
      ended = true;
      throw error;
    }
  }
  return {
    write(message): void {
      if (ended) return;
      try {
        const bytes = Buffer.from(message);
        let offset = 0;
        while (offset < bytes.length) {
          if (size >= LOG_ROTATE_THRESHOLD_BYTES) {
            closeDescriptor();
            storage.renameSync(path, `${path}.1`);
            size = 0;
          }
          fd ??= storage.openSync(path, 'wx', 0o600);
          const count = Math.min(bytes.length - offset, LOG_ROTATE_THRESHOLD_BYTES - size);
          const written = storage.writeSync(fd, bytes, offset, count, null);
          offset += written;
          size += written;
        }
      } catch {
        // Diagnostic failures must not select a startup or recovery disposition.
      }
    },
    close(clean): void {
      if (ended) return;
      ended = true;
      try {
        closeDescriptor();
        closed(clean);
      } catch {
        // A failed closure certificate cannot authorize retention or change process exit.
      }
    },
  };
}

function ensureLogsDirectory(runDir: string, storage: CoordinatorLogStorage): string {
  const logsDir = join(runDir, 'coordinator-logs');
  try {
    storage.mkdirSync(logsDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return logsDir;
}

function publishWriter(ports: CoordinatorLogPorts, logsDir: string, writer: Writer): string {
  const stage = join(logsDir, `.stage-${writer.role}-${writer.pid}-${incarnationDigest(writer.incarnation)}`);
  ports.storage.mkdirSync(stage, { mode: 0o700 });
  ports.storage.writeFileSync(join(stage, 'writer.json'), `${JSON.stringify(writer)}\n`, { flag: 'wx', mode: 0o600 });
  const directory = join(logsDir, ports.ids.uuid());
  if (ports.storage.readdirSync(logsDir).includes(basename(directory))) throw new Error('Log namespace already exists');
  ports.storage.renameSync(stage, directory);
  return directory;
}

function publishLogPointer(storage: CoordinatorLogStorage, path: string, writer: Writer): void {
  const logsDir = dirname(dirname(path));
  const pointer = join(logsDir, `latest-${writer.role}.json`);
  const temporary = join(dirname(path), 'pointer.tmp');
  try {
    storage.writeFileSync(temporary, `${JSON.stringify({ path, writer })}\n`, { flag: 'w', mode: 0o600 });
    storage.renameSync(temporary, pointer);
  } finally {
    try {
      storage.unlinkSync(temporary);
    } catch {
      // Failed cleanup of the writer's own temporary cannot disable private diagnostics.
    }
  }
  try {
    const legacy = join(dirname(logsDir), 'coordinator.log');
    if (storage.lstatSync(legacy).isFile()) {
      const label = writer.role === 'coordinator' ? 'Coordinator' : 'Supervisor';
      storage.appendFileSync(
        legacy,
        `${label} diagnostics (best-effort; may name an earlier writer): ${pointer}; current coordinator path: coordinatorLogPath in detailed /health or startup-diagnostic.json\n`,
      );
    }
  } catch {
    // Legacy discovery cannot prevent diagnostics at their private address.
  }
}

/** Native O_APPEND writers share one path; no launcher can certify inherited descriptors closed. */
export function withCoordinatorLog<T>(
  runDir: string,
  launch: (stderr: number) => T,
  ports: CoordinatorLogPorts = nodePorts,
): T {
  const { storage } = ports;
  let fd: number;
  try {
    ensureLogsDirectory(runDir, storage);
    fd = storage.openSync(join(runDir, COORDINATOR_NATIVE_STDERR_PATH), 'a', 0o600);
  } catch {
    return launch(2);
  }
  try {
    return launch(fd);
  } finally {
    try {
      storage.closeSync(fd);
    } catch {
      // A diagnostic close failure cannot change the child's launch disposition.
    }
  }
}

/** Private diagnostics must remain independent of the inherited stderr reader's lifetime. */
export function installCoordinatorLog(
  runDir: string,
  ports: CoordinatorLogPorts = nodePorts,
  role: LogRole = 'coordinator',
): void {
  setBackendLogSink((message) => {
    try {
      const bytes = Buffer.from(message);
      let offset = 0;
      while (offset < bytes.length) {
        offset += ports.storage.writeSync(2, bytes, offset, bytes.length - offset, null);
      }
    } catch {
      // Unusable inherited stderr cannot change the process disposition.
    }
  });
  currentLog = undefined;
  try {
    const { storage } = ports;
    const pid = ports.env.pid();
    const incarnation = ports.process.readProcessIncarnation(pid, ports.env.platform() as NodeJS.Platform);
    if (incarnation === null) return;
    const record: Writer = { version: 1, role, pid, incarnation };
    const logsDir = ensureLogsDirectory(runDir, storage);
    pruneLogs(ports, logsDir, incarnation);
    const directory = publishWriter(ports, logsDir, record);
    const path = join(directory, 'current.log');
    const writer = createLogWriter(storage, path, (clean) => {
      if (clean)
        storage.writeFileSync(join(directory, 'segments-closed'), basename(directory), { flag: 'wx', mode: 0o600 });
      pruneLogs(ports, logsDir, incarnation);
    });
    currentLog = { role, path };
    setBackendLogSink((message) => writer.write(message));
    let maintenance: TimerHandle | null = null;
    process.once('exit', (code) => {
      try {
        ports.time.clearInterval(maintenance);
      } catch {
        // Timer cleanup cannot change the process disposition.
      }
      if (code !== 0) writer.write(`${role} ${pid} exited with code ${code}\n`);
      writer.close(code === 0);
    });
    try {
      publishLogPointer(storage, path, record);
    } catch {
      // Discovery failure cannot disable private diagnostics or retention.
    }
    pruneLogs(ports, logsDir, incarnation);
    maintenance = ports.time.setInterval(() => pruneLogs(ports, logsDir, incarnation), LOG_RETENTION_INTERVAL_MS);
    maintenance.unref?.();
  } catch {
    // Diagnostic failures must not select a startup or recovery disposition.
  }
}
