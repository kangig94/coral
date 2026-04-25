import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectSource } from "../../infra/project-source.js";
import { SYSTEM_TIME_PORT, nowDate } from '../../infra/time.js';
import type { RuntimeTimePort } from '../../runtime/ports.js';
import { isNoEntryError, unlinkIfExists } from '../../infra/fs-errors.js';
import { parseMemoFrontmatter, serializeMemoFrontmatter } from '../corpus/frontmatter.js';
import type {
  KbMemoDeleteInput,
  KbMemoDeleteResult,
  KbMemoInput,
  KbMemoListResult,
  KbMemoPurgeResult,
} from '../entry-types.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { memoDir } from '../paths.js';
import { compareLocale } from '../validation.js';

function generateTimestamp(time: Pick<RuntimeTimePort, 'now'> = SYSTEM_TIME_PORT): string {
  const now = nowDate(time);
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

export function writeMemo(
  projectRoot: string,
  input: KbMemoInput,
  time: Pick<RuntimeTimePort, 'now'> = SYSTEM_TIME_PORT,
): { filename: string; path: string } {
  const source = resolveProjectSource(projectRoot);
  const dir = memoDir(projectRoot);
  const timestamp = generateTimestamp(time);
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
  const sortKey = Date.UTC(year, month - 1, day, hour, minute, second);

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
      try {
        const path = join(dir, filename);
        const raw = readFileSync(path, 'utf-8');
        const memo = parseTimestampPrefix(filename);

        let owner: string | undefined;
        try {
          const parsed = parseMemoFrontmatter(raw);
          owner = parsed.owner;
        } catch {
          // Memos without valid frontmatter are treated as unowned.
        }

        if (ownerFilter !== undefined && owner !== ownerFilter) {
          return [];
        }

        const createdAt = memo?.display ?? statSync(path).mtime.toISOString();
        const sortKey = memo?.sortKey ?? (Date.parse(createdAt) || 0);

        return [{ filename, summary: extractSummary(raw), createdAt, sortKey, owner }];
      } catch {
        return [];
      }
    });

  memos.sort((left, right) => right.sortKey - left.sortKey || compareLocale(left.filename, right.filename));

  return {
    memos: memos.map(({ filename, summary, createdAt, owner }) => ({ filename, summary, createdAt, owner })),
  };
}

export function deleteMemos(projectRoot: string, input: KbMemoDeleteInput): KbMemoDeleteResult {
  const dir = memoDir(projectRoot);
  const matcher = globToRegex(input.pattern);
  const deleted = readMemoDir(projectRoot)
    .filter((filename) => filename.endsWith('.md'))
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
    unlinkIfExists(join(dir, filename));
  }

  return { deleted, count: deleted.length };
}

export function purgeMemos(projectRoot: string, owner?: string): KbMemoPurgeResult {
  return { deleted: deleteMemos(projectRoot, { pattern: '*', owner }).count };
}
