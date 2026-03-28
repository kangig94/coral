import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectSource } from '../infra/paths.js';
import { isNoEntryError } from '../shared/mcp-utils.js';
import { parseMemoFrontmatter, serializeMemoFrontmatter } from './frontmatter.js';
import type {
  KbMemoDeleteInput,
  KbMemoDeleteResult,
  KbMemoInput,
  KbMemoListResult,
  KbMemoPurgeResult,
} from './types.js';
import { writeFileAtomic } from './mutation-helpers.js';
import { memoDir } from './paths.js';
import { compareLocale } from './validation.js';

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
  const timestamp = generateTimestamp();
  const filename = `${timestamp}-${input.topic}.md`;
  const path = join(dir, filename);

  const frontmatter = serializeMemoFrontmatter({ source, owner: input.owner });
  const body = `${frontmatter}\n\n${input.content.trim()}\n`;
  writeFileAtomic(path, body);

  return { filename, path };
}

function readMemoDir(projectRoot: string): string[] {
  try {
    return readdirSync(memoDir(projectRoot));
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return [];
    }
    throw error;
  }
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function extractSummary(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let start = 0;

  if (lines[0] === '---') {
    const frontmatterEnd = lines.findIndex((line, index) => index > 0 && line === '---');
    if (frontmatterEnd !== -1) {
      start = frontmatterEnd + 1;
    }
  }

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line) {
      return line;
    }
  }

  return '';
}

function parseTimestampPrefix(filename: string): { display: string; sortKey: number } | null {
  const match = filename.match(/^(\d{8}-\d{6})/);
  if (!match) {
    return null;
  }

  const [datePart, timePart] = match[1].split('-');
  const year = Number.parseInt(datePart.slice(0, 4), 10);
  const month = Number.parseInt(datePart.slice(4, 6), 10);
  const day = Number.parseInt(datePart.slice(6, 8), 10);
  const hour = Number.parseInt(timePart.slice(0, 2), 10);
  const minute = Number.parseInt(timePart.slice(2, 4), 10);
  const second = Number.parseInt(timePart.slice(4, 6), 10);
  const sortKey = new Date(year, month - 1, day, hour, minute, second).getTime();

  if (Number.isNaN(sortKey)) {
    return null;
  }

  return { display: match[1], sortKey };
}

export function listMemos(projectRoot: string, ownerFilter?: string): KbMemoListResult {
  const dir = memoDir(projectRoot);
  const memos = readMemoDir(projectRoot)
    .filter((filename) => filename.endsWith('.md'))
    .flatMap((filename) => {
      const path = join(dir, filename);
      const stat = statSync(path);
      if (!stat.isFile()) {
        return [];
      }
      const memo = parseTimestampPrefix(filename);
      const raw = readFileSync(path, 'utf-8');

      let owner: string | undefined;
      try {
        const parsed = parseMemoFrontmatter(raw);
        owner = parsed.owner;
      } catch {
        // Legacy memos without valid frontmatter: treat as unowned
      }

      if (ownerFilter !== undefined && owner !== ownerFilter) {
        return [];
      }

      return [{
        filename,
        summary: extractSummary(raw),
        createdAt: memo?.display ?? stat.mtime.toISOString(),
        sortKey: memo?.sortKey ?? stat.mtimeMs,
        owner,
      }];
    });

  memos.sort((left, right) =>
    right.sortKey - left.sortKey
    || compareLocale(left.filename, right.filename));

  return {
    memos: memos.map(({ filename, summary, createdAt, owner }) => ({ filename, summary, createdAt, owner })),
  };
}

export function deleteMemos(projectRoot: string, input: KbMemoDeleteInput): KbMemoDeleteResult {
  const dir = memoDir(projectRoot);
  const matcher = globToRegex(input.pattern);
  const deleted = readMemoDir(projectRoot)
    .filter((filename) => filename.endsWith('.md'))
    .filter((filename) => statSync(join(dir, filename)).isFile())
    .filter((filename) => matcher.test(filename))
    .filter((filename) => {
      if (input.owner === undefined) return true;
      try {
        const raw = readFileSync(join(dir, filename), 'utf-8');
        const parsed = parseMemoFrontmatter(raw);
        return parsed.owner === input.owner;
      } catch {
        return false;
      }
    })
    .sort(compareLocale);

  for (const filename of deleted) {
    unlinkSync(join(dir, filename));
  }

  return { deleted, count: deleted.length };
}

export function purgeMemos(projectRoot: string): KbMemoPurgeResult {
  const dir = memoDir(projectRoot);
  const deleted = readMemoDir(projectRoot)
    .filter((filename) => filename.endsWith('.md'))
    .filter((filename) => statSync(join(dir, filename)).isFile())
    .sort(compareLocale);

  for (const filename of deleted) {
    unlinkSync(join(dir, filename));
  }

  return { deleted: deleted.length };
}
