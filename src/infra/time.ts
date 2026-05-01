type TimeNowPort = {
  now(): number;
};

export function nowDate(time: TimeNowPort): Date {
  return new Date(time.now());
}

export function nowIsoString(timeOrEpoch: TimeNowPort | number): string {
  const epochMs = typeof timeOrEpoch === 'number' ? timeOrEpoch : timeOrEpoch.now();
  return new Date(epochMs).toISOString();
}
