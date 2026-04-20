import { createHash } from 'node:crypto';
import { noteEntryId, sourceEntryId, type EntryRecord } from '../entry-types.js';
import type { ChunkRecord } from './needle-store.js';

const MAX_CHUNK_TOKENS = 2048;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_CHARS = MAX_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;

export type ChunkSeed = Omit<ChunkRecord, 'specId' | 'vector'>;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function chunkHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function splitSections(body: string): string[] {
  const trimmed = body.trim();
  if (trimmed === '') {
    return [''];
  }

  const sections: string[] = [];
  let current: string[] = [];

  for (const line of trimmed.split(/\r?\n/)) {
    const isSectionHeader = line.startsWith('## ') || line.startsWith('### ');
    if (isSectionHeader && current.length > 0) {
      sections.push(current.join('\n').trim());
      current = [];
    }
    current.push(line);
  }

  if (current.length > 0) {
    sections.push(current.join('\n').trim());
  }

  return sections;
}

function splitOversizeParagraph(paragraph: string): string[] {
  const pieces: string[] = [];
  let start = 0;

  while (start < paragraph.length) {
    pieces.push(paragraph.slice(start, start + MAX_CHUNK_CHARS).trim());
    start += MAX_CHUNK_CHARS;
  }

  return pieces.filter((piece) => piece.length > 0);
}

function splitAtParagraphBoundaries(prefix: string, section: string): string[] {
  const prefixed = `${prefix}${section}`.trim();
  if (estimateTokens(prefixed) <= MAX_CHUNK_TOKENS) {
    return [prefixed];
  }

  const paragraphs = section
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  if (paragraphs.length === 0) {
    return [prefixed];
  }

  const chunks: string[] = [];
  let current = '';

  const pushCurrent = (): void => {
    if (current !== '') {
      chunks.push(`${prefix}${current}`.trim());
      current = '';
    }
  };

  for (const paragraph of paragraphs) {
    const parts = estimateTokens(`${prefix}${paragraph}`) <= MAX_CHUNK_TOKENS
      ? [paragraph]
      : splitOversizeParagraph(paragraph);

    for (const part of parts) {
      const next = current === '' ? part : `${current}\n\n${part}`;
      if (estimateTokens(`${prefix}${next}`) <= MAX_CHUNK_TOKENS) {
        current = next;
        continue;
      }

      pushCurrent();
      current = part;
    }
  }

  pushCurrent();
  return chunks.length === 0 ? [prefixed] : chunks;
}

export function chunkEntry(entry: EntryRecord, body: string): ChunkSeed[] {
  if (entry.kind === 'community') {
    return [];
  }

  const entryId = entry.kind === 'note' ? noteEntryId(entry.slug) : sourceEntryId(entry.slug);
  const prefix = `# ${entry.title}\n\n`;
  const sections = entry.kind === 'note' ? [body.trim()] : splitSections(body);
  const texts = sections.flatMap((section) => splitAtParagraphBoundaries(prefix, section));

  return texts.map((text, chunkIndex) => ({
    id: `${entryId}::${chunkIndex}`,
    entryId,
    entryKind: entry.kind,
    chunkIndex,
    text,
    contentHash: chunkHash(text),
  }));
}
