import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logHookLine } from './hook-utils.mjs';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const UPDATED_AT_PATTERN = /^updatedAt:[ \t]*(.+)$/m;
const UNDERSTANDING_HEADER_PATTERN = /^## Understanding[ \t]*(?:\r?\n|$)/m;
const NEXT_SECTION_HEADER_PATTERN = /^## /m;

function readIdentity(kbRoot) {
  try {
    const identityPath = join(kbRoot, 'identity.md');
    if (existsSync(identityPath)) {
      return readFileSync(identityPath, 'utf-8').trimEnd();
    }
  } catch (error) {
    logHookLine('session-start', 'wake-up parse error: ' + (error instanceof Error ? error.message : String(error)));
  }
  return null;
}

function readWikiChunk(wikiPath, projectSlug) {
  try {
    const content = readFileSync(wikiPath, 'utf-8');
    const fmMatch = content.match(FRONTMATTER_PATTERN);
    if (!fmMatch) return null;

    const updatedAtMatch = fmMatch[1].match(UPDATED_AT_PATTERN);
    const updatedAt = updatedAtMatch ? updatedAtMatch[1].trim() : '';

    const body = content.slice(fmMatch[0].length);
    const understandingMatch = body.match(UNDERSTANDING_HEADER_PATTERN);
    if (!understandingMatch) return null;
    const sectionStart = (understandingMatch.index ?? 0) + understandingMatch[0].length;
    const tail = body.slice(sectionStart);
    const nextHeaderMatch = tail.match(NEXT_SECTION_HEADER_PATTERN);
    const understanding = (nextHeaderMatch ? tail.slice(0, nextHeaderMatch.index) : tail).trim();

    return `## ${projectSlug} (${updatedAt})\n${understanding}\n`;
  } catch (error) {
    logHookLine('session-start', 'wake-up parse error: ' + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}

export function readProjectScopedWakeUp(kbRoot, projectSlug) {
  const wikiPath = join(kbRoot, 'wiki', `${projectSlug}.md`);
  const wikiChunk = existsSync(wikiPath) ? readWikiChunk(wikiPath, projectSlug) ?? '' : '';
  const identity = readIdentity(kbRoot);

  if (identity === null || identity.length === 0) {
    return wikiChunk.length === 0 ? null : wikiChunk;
  }
  return `${identity}\n\n${wikiChunk}`;
}
