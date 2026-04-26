import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coralRoot } from "../infra/path/root.js";

export function coralEnvPath(): string {
  return join(coralRoot(), '.env');
}

export function parseCoralEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 1) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Reads the on-disk Coral env file and returns its parsed map. Does NOT
 * mutate `process.env` — callers compose their own lookup chain (e.g.
 * `process.env[key] ?? fileEnv[key]`) so env precedence stays explicit
 * per design-philosophy.md Principle #4 (Single Runtime World).
 */
export function readCoralEnvFile(): Record<string, string> {
  const envPath = coralEnvPath();
  if (!existsSync(envPath)) {
    return {};
  }
  return parseCoralEnv(readFileSync(envPath, 'utf8'));
}

