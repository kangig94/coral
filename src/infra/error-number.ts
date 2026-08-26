export function errorNumber(error: unknown, fallback: number): number {
  if (typeof error !== 'object' || error === null) return fallback;
  const candidate = 'errcode' in error ? error.errcode : 'errno' in error ? error.errno : fallback;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : fallback;
}
