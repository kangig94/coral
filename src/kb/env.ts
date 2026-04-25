import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coralRoot } from "../infra/coral-root.js";

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

export function loadCoralEnv(): void {
  const envPath = coralEnvPath();
  if (!existsSync(envPath)) {
    return;
  }

  const parsed = parseCoralEnv(readFileSync(envPath, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] ??= value;
  }
}

function serializeCoralEnvValue(value: string): string {
  if (value === '' || /\s|#/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

export function writeCoralEnvConfig(values: Record<string, string>): void {
  const envPath = coralEnvPath();
  const current = existsSync(envPath) ? parseCoralEnv(readFileSync(envPath, 'utf8')) : {};
  const merged = { ...current, ...values };
  const lines = Object.entries(merged)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${serializeCoralEnvValue(value)}`);
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;

  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, body, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(envPath, 0o600);
  }
}
