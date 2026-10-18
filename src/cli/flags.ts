import { existsSync, readFileSync, statSync } from 'node:fs';

import { UsageError } from './errors.js';

export function resolveFilePath(filePath: string): string {
  if (existsSync(filePath)) return filePath;
  if (!filePath.endsWith('.md')) {
    const withMd = `${filePath}.md`;
    if (existsSync(withMd)) return withMd;
  }
  return filePath;
}

const STDIN_INPUT = '-';
let stdinConsumed = false;

function readStdinInput(): string {
  if (stdinConsumed) {
    throw new UsageError(`Only one input per command can be read from stdin ("${STDIN_INPUT}")`);
  }
  stdinConsumed = true;
  return readFileSync(0, 'utf8');
}

/**
 * A path or `-` that is only one token among several must stay literal text. Only an input that is exactly `-`
 * may read stdin: it is how a quoted heredoc (`<<'EOF'`) passes text the shell left unexpanded.
 */
export function resolveInput(values: string[]): string {
  const input = values.join(' ');
  if (input === STDIN_INPUT) return readStdinInput();
  if (existsSync(input) && statSync(input).isFile()) return readFileSync(input, 'utf8');
  return input;
}

export function parseIntegerFlag(flagName: string, value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new UsageError(`${flagName} must be an integer`);
  }

  return Number.parseInt(value, 10);
}

export function parseJobIds(raw: string): string[] {
  const jobIds: string[] = [];
  for (const entry of raw.split(/[,\s]+/u)) {
    const trimmed = entry.trim();
    if (trimmed.length > 0 && !jobIds.includes(trimmed)) {
      jobIds.push(trimmed);
    }
  }
  if (jobIds.length === 0) {
    throw new UsageError('jobs must include at least one job ID');
  }

  return jobIds;
}
