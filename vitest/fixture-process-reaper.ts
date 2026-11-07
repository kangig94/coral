import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';

const SCOPE_KEY = 'CORAL_TEST_PROCESS_SCOPE';
const REAP_PASSES = 5;
const DEPARTURE_WAIT_MS = 2_000;
const REPORTED_COMMAND_CHARS = 160;

export type FixtureProcess = Readonly<{ pid: number; startTicks: string; command: string }>;

export type FixtureProcessBoundary = Readonly<{
  /** Absent or relative means no HOME is trusted to belong to a fixture. */
  tempRoot: string | undefined;
  /** Every worker of the run shares these; a HOME match on one would reach all of them. */
  sharedHomes: ReadonlySet<string>;
}>;

type Candidate = FixtureProcess & Readonly<{ scope: string | undefined; home: string | undefined }>;

export function enterFixtureProcessScope(): string {
  const scope = randomUUID();
  process.env[SCOPE_KEY] = scope;
  return scope;
}

function readStat(pid: number): { ppid: number; startTicks: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const startTicks = fields[19];
    if (startTicks === undefined || fields[0] === 'Z') return null;
    return { ppid: Number(fields[1]), startTicks };
  } catch {
    return null;
  }
}

/** A direct child of this worker has an owner that is not this reaper. */
function readCandidate(pid: number): Candidate | null {
  const stat = readStat(pid);
  if (stat === null || stat.ppid === process.pid) return null;
  try {
    const env = new Map<string, string>();
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const split = entry.indexOf('=');
      if (split > 0) env.set(entry.slice(0, split), entry.slice(split + 1));
    }
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    return {
      pid,
      startTicks: stat.startTicks,
      command: command.slice(0, REPORTED_COMMAND_CHARS),
      scope: env.get(SCOPE_KEY),
      home: env.get('HOME'),
    };
  } catch {
    return null;
  }
}

function alive(target: FixtureProcess): boolean {
  return readStat(target.pid)?.startTicks === target.startTicks;
}

function fixtureProcesses(scope: string, boundary: FixtureProcessBoundary): FixtureProcess[] {
  const all = readdirSync('/proc')
    .filter((entry) => /^\d+$/u.test(entry) && Number(entry) !== process.pid)
    .flatMap((entry) => readCandidate(Number(entry)) ?? []);
  const { tempRoot, sharedHomes } = boundary;
  const fixtureHomes = new Set(
    all.flatMap(({ scope: owner, home }) =>
      owner === scope &&
      home !== undefined &&
      tempRoot !== undefined &&
      isAbsolute(tempRoot) &&
      home.startsWith(tempRoot + sep) &&
      !sharedHomes.has(home)
        ? [home]
        : [],
    ),
  );
  return all
    .filter(
      (candidate) => candidate.scope === scope || (candidate.home !== undefined && fixtureHomes.has(candidate.home)),
    )
    .map(({ pid, startTicks, command }) => ({ pid, startTicks, command }));
}

export async function reapFixtureProcesses(scope: string, boundary: FixtureProcessBoundary): Promise<FixtureProcess[]> {
  if (process.platform !== 'linux') return [];
  const reaped = new Map<string, FixtureProcess>();
  for (let pass = 0; pass < REAP_PASSES; pass++) {
    const leaked = fixtureProcesses(scope, boundary);
    if (leaked.length === 0) return [...reaped.values()];
    for (const leak of leaked) {
      if (!alive(leak)) continue;
      reaped.set(`${leak.pid}:${leak.startTicks}`, leak);
      try {
        process.kill(leak.pid, 'SIGKILL');
      } catch {
        // A signalling failure must not hide a survivor.
      }
    }
    const deadline = Date.now() + DEPARTURE_WAIT_MS;
    while (leaked.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const survivors = fixtureProcesses(scope, boundary);
  if (survivors.length > 0) {
    throw new Error(
      `Fixture processes outlived the test file: ${survivors.map(({ pid, command }) => `${pid} ${command}`).join('; ')}`,
    );
  }
  return [...reaped.values()];
}
