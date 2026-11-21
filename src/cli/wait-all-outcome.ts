export type WaitAllOutcome = { kind: 'refused' } | { kind: 'terminal'; code: number; precedingJobs: number };

export function parseWaitAllOutcome(value: string, jobCount: number): WaitAllOutcome | undefined {
  if (value === 'refused') return { kind: 'refused' };
  const match = /^([1-9]\d{0,2}):(0|[1-9]\d*)$/.exec(value);
  if (match === null) return undefined;
  const code = Number(match[1]);
  const precedingJobs = Number(match[2]);
  if (code > 255 || precedingJobs > jobCount) return undefined;
  return { kind: 'terminal', code, precedingJobs };
}

export function encodeWaitAllOutcome(outcome: WaitAllOutcome): string {
  return outcome.kind === 'refused' ? 'refused' : `${outcome.code}:${outcome.precedingJobs}`;
}
