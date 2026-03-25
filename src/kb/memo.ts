import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectSource } from '../client/paths.js';
import { memoDir } from './paths.js';

export type KbMemoInput = {
  topic: string;
  content: string;
};

function generateTimestamp(): string {
  const now = new Date();
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function writeMemo(projectRoot: string, input: KbMemoInput): { filename: string; path: string } {
  const source = resolveProjectSource(projectRoot);
  const dir = memoDir(projectRoot);
  mkdirSync(dir, { recursive: true });

  const timestamp = generateTimestamp();
  const filename = `${timestamp}-${input.topic}.md`;
  const path = join(dir, filename);

  const body = `---\nsource: ${source}\n---\n\n${input.content.trim()}\n`;
  writeFileSync(path, body, 'utf-8');

  return { filename, path };
}
