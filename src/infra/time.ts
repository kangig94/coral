type TimeNowPort = {
  now(): number;
};

export function nowIsoString(timeOrEpoch?: TimeNowPort | number): string {
  const epochMs =
    typeof timeOrEpoch === 'number' ? timeOrEpoch : timeOrEpoch !== undefined ? timeOrEpoch.now() : Date.now();
  return new Date(epochMs).toISOString();
}
