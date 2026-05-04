import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logHookLine } from './hook-utils.mjs';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const UPDATED_AT_PATTERN = /^updatedAt:[ \t]*(.+)$/m;
const UNDERSTANDING_HEADER_PATTERN = /^## Understanding[ \t]*(?:\r?\n|$)/m;
const NEXT_SECTION_HEADER_PATTERN = /^## /m;

export function readProjectScopedWakeUp(kbRoot, projectSlug) {
  const wikiPath = join(kbRoot, 'wiki', `${projectSlug}.md`);
  if (!existsSync(wikiPath)) {
    return null;
  }

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
