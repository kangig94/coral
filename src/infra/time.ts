type TimeNowPort = {
  now(): number;
};

export const SYSTEM_TIME_PORT: TimeNowPort = {
  now: () => Date.now(),
};

export function nowDate(time: TimeNowPort = SYSTEM_TIME_PORT): Date {
  return new Date(time.now());
}

export function nowIsoString(timeOrEpoch?: TimeNowPort | number): string {
  const epochMs =
    typeof timeOrEpoch === 'number'
      ? timeOrEpoch
      : timeOrEpoch !== undefined
        ? timeOrEpoch.now()
        : SYSTEM_TIME_PORT.now();
  return new Date(epochMs).toISOString();
}
