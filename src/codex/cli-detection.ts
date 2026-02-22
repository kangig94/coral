/**
 * Codex CLI detection and validation.
 * Caches the result so we only check once per server lifetime.
 */

import { execFile } from 'node:child_process';

type CliInfo = {
  available: boolean;
  version?: string;
  error?: string;
};

let cached: CliInfo | null = null;

export async function detectCodexCli(): Promise<CliInfo> {
  if (cached) return cached;
  cached = await queryCodexCli();
  return cached;
}

export function resetCliCache(): void {
  cached = null;
}

function queryCodexCli(): Promise<CliInfo> {
  return new Promise<CliInfo>((resolve) => {
    execFile('codex', ['--version'], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve({
          available: false,
          error: 'Codex CLI not found. Install it with: npm install -g @openai/codex',
        });
        return;
      }
      resolve({ available: true, version: stdout.trim() });
    });
  });
}
