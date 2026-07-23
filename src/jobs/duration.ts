export function elapsedDurationMs(startTime: string, endTimeMs: number, subject: string): number {
  const startTimeMs = Date.parse(startTime);
  if (!Number.isFinite(startTimeMs)) {
    throw new Error(`Cannot calculate ${subject} duration from invalid start time '${startTime}'.`);
  }
  if (!Number.isFinite(endTimeMs)) {
    throw new Error(`Cannot calculate ${subject} duration from invalid end time '${String(endTimeMs)}'.`);
  }
  return Math.max(0, endTimeMs - startTimeMs);
}
