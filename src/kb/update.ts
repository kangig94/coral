import { readFileSync } from 'node:fs';
import { nowIsoString } from '../shared/mcp-utils.js';
import { parseFrontmatter, extractTitle, serializeNote } from './frontmatter.js';
import { notePathFromName } from './paths.js';
import type { KbUpdateInput } from './contracts.js';
import type { KbContext } from './types.js';
import {
  readKbIndex,
  recordMutationCommitted,
  withKbMutationLock,
  writeKbIndex,
} from './detect.js';
import {
  assertNonEmptyText,
  assertSlug,
  cloneKbIndex,
  markTextIndexStale,
  normalizePrinciples,
  normalizeTags,
  writeFileAtomic,
} from './mutation-helpers.js';

const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/;
const TOP_LEVEL_TITLE = /^# .+(?:\r?\n){1,2}/;

function extractBody(content: string): string {
  return content
    .replace(FRONTMATTER_BLOCK, '')
    .replace(TOP_LEVEL_TITLE, '')
    .trim();
}

export async function update(_kb: KbContext, input: KbUpdateInput): Promise<{ path: string }> {
  const note = assertSlug(input.note, 'note');
  const notePath = notePathFromName(note);
  const title = input.title === undefined ? undefined : assertNonEmptyText(input.title, 'title');
  if (input.content !== undefined && typeof input.content !== 'string') {
    throw new Error('content must be a string');
  }
  const nextContent = input.content;
  const tags = input.tags === undefined ? undefined : normalizeTags(input.tags);
  const principles = input.principles === undefined ? undefined : normalizePrinciples(input.principles);

  return withKbMutationLock(async () => {
    const existing = readFileSync(notePath, 'utf-8');
    const frontmatter = parseFrontmatter(existing);
    const existingTitle = extractTitle(existing);
    const existingBody = extractBody(existing);
    const updatedAt = nowIsoString();
    const normalizedTitle = title ?? existingTitle;
    const normalizedContent = nextContent ?? existingBody;
    const normalizedTags = tags ?? frontmatter.tags;
    const normalizedPrinciples = principles ?? frontmatter.principles;

    writeFileAtomic(notePath, serializeNote({
      tags: normalizedTags,
      principles: normalizedPrinciples,
      source: frontmatter.source,
      createdAt: frontmatter.createdAt,
      updatedAt,
    }, normalizedTitle, normalizedContent));
    recordMutationCommitted();

    const nextIndex = cloneKbIndex(readKbIndex());
    nextIndex.notes[note] = {
      title: normalizedTitle,
      tags: [...normalizedTags],
      principles: [...normalizedPrinciples],
      source: [...frontmatter.source],
      createdAt: frontmatter.createdAt,
      updatedAt,
    };
    writeKbIndex(nextIndex);

    await markTextIndexStale('KB text snapshot is stale after kb_update.');

    return { path: notePath };
  });
}
