export function readProcessEnv(key: string): string | undefined {
  return process.env[key];
}
