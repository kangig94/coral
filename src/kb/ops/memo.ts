import { join } from 'node:path';
import { nowDate } from '../../infra/time.js';
import type { StoragePort, TimePort } from '../../infra/port-types.js';
import type { IdPort } from '../../runtime/ports.js';
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

export type MemoStorage = Pick<
  StoragePort,
  'readFileSync' | 'readdirSync' | 'statSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync' | 'unlinkSync'
>;
export type MemoHost = {
  readonly storagePort: MemoStorage;
  readonly ids: Pick<IdPort, 'uuid'>;
};

function generateTimestamp(time: Pick<TimePort, 'now'>): string {
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
  host: MemoHost,
  projectDataDir: string,
  source: string,
  input: KbMemoInput,
  time: Pick<TimePort, 'now'>,
): { filename: string; path: string } {
  const dir = memoDir(projectDataDir);
  const timestamp = generateTimestamp(time);
  const filename = `${timestamp}-${input.topic}.md`;
  const path = join(dir, filename);

  const frontmatter = serializeMemoFrontmatter({ source, owner: input.owner });
  const body = `${frontmatter}\n\n${input.content.trim()}\n`;
  writeFileAtomic(host, path, body);

  return { filename, path };
}

function readMemoDir(storage: Pick<StoragePort, 'readdirSync'>, projectDataDir: string): string[] {
  try {
    return storage.readdirSync(memoDir(projectDataDir));
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

export function listMemos(storage: MemoStorage, projectDataDir: string, ownerFilter?: string): KbMemoListResult {
  const dir = memoDir(projectDataDir);
  const memos: Array<{ filename: string; summary: string; createdAt: string; sortKey: number; owner?: string }> = [];

  for (const filename of readMemoDir(storage, projectDataDir)) {
    if (!filename.endsWith('.md')) {
      continue;
    }

    try {
      const path = join(dir, filename);
      const raw = storage.readFileSync(path, 'utf-8');
      const memo = parseTimestampPrefix(filename);

      let owner: string | undefined;
      try {
        const parsed = parseMemoFrontmatter(raw);
        owner = parsed.owner;
      } catch {
        // Memos without valid frontmatter are treated as unowned.
      }

      if (ownerFilter !== undefined && owner !== ownerFilter) {
        continue;
      }

      const mtimeMs = storage.statSync(path).mtimeMs;
      const createdAt = memo?.display ?? new Date(mtimeMs).toISOString();
      let sortKey = memo?.sortKey;
      sortKey ??= memo === null ? mtimeMs : Date.parse(createdAt) || 0;

      memos.push({ filename, summary: extractSummary(raw), createdAt, sortKey, owner });
    } catch {
      // Ignore unreadable or malformed memo files while listing.
    }
  }

  memos.sort((left, right) => right.sortKey - left.sortKey || compareLocale(left.filename, right.filename));

  const listedMemos: KbMemoListResult['memos'] = [];
  for (const { filename, summary, createdAt, owner } of memos) {
    listedMemos.push({ filename, summary, createdAt, owner });
  }

  return {
    memos: listedMemos,
  };
}

export function deleteMemos(
  storage: MemoStorage,
  projectDataDir: string,
  input: KbMemoDeleteInput,
): KbMemoDeleteResult {
  const dir = memoDir(projectDataDir);
  const matcher = globToRegex(input.pattern);
  const deleted: string[] = [];

  for (const filename of readMemoDir(storage, projectDataDir)) {
    if (!filename.endsWith('.md') || !matcher.test(filename)) {
      continue;
    }

    if (input.owner !== undefined) {
      try {
        const raw = storage.readFileSync(join(dir, filename), 'utf-8');
        const parsed = parseMemoFrontmatter(raw);
        if (parsed.owner !== input.owner) {
          continue;
        }
      } catch {
        continue;
      }
    }

    deleted.push(filename);
  }

  deleted.sort(compareLocale);

  for (const filename of deleted) {
    unlinkIfExists(join(dir, filename), storage);
  }

  return { deleted, count: deleted.length };
}

export function purgeMemos(storage: MemoStorage, projectDataDir: string, owner?: string): KbMemoPurgeResult {
  return { deleted: deleteMemos(storage, projectDataDir, { pattern: '*', owner }).count };
}
