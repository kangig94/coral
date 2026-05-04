import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadYaml, logHookLine } from './hook-utils.mjs';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const UNDERSTANDING_HEADER_PATTERN = /^## Understanding[ \t]*(?:\r?\n|$)/m;
const NEXT_SECTION_HEADER_PATTERN = /^## /m;

export function readProjectScopedWakeUp(kbRoot, project) {
  const wikiDir = join(kbRoot, 'wiki');
  let wikiFiles;
  try {
    wikiFiles = readdirSync(wikiDir).filter((name) => name.endsWith('.md'));
  } catch (error) {
    logHookLine('session-start', 'wake-up parse error: ' + (error instanceof Error ? error.message : String(error)));
    return null;
  }

  const yaml = loadYaml();
  if (yaml === null) {
    logHookLine('session-start', 'wake-up parse error: yaml package unavailable');
    return null;
  }

  const matched = [];
  for (const fileName of wikiFiles) {
    try {
      const filePath = join(wikiDir, fileName);
      const content = readFileSync(filePath, 'utf-8');
      const fmMatch = content.match(FRONTMATTER_PATTERN);
      if (!fmMatch) continue;

      const meta = yaml.parse(fmMatch[1]);
      if (!meta || typeof meta !== 'object' || meta.project !== project) continue;

      const body = content.slice(fmMatch[0].length);
      const understandingMatch = body.match(UNDERSTANDING_HEADER_PATTERN);
      if (!understandingMatch) continue;
      const sectionStart = (understandingMatch.index ?? 0) + understandingMatch[0].length;
      const tail = body.slice(sectionStart);
      const nextHeaderMatch = tail.match(NEXT_SECTION_HEADER_PATTERN);
      const understanding = (nextHeaderMatch ? tail.slice(0, nextHeaderMatch.index) : tail).trim();

      const slug = fileName.endsWith('.md') ? fileName.slice(0, -3) : fileName;
      const updatedAt = typeof meta.updatedAt === 'string' ? meta.updatedAt : '';
      matched.push({ slug, updatedAt, understanding });
    } catch (error) {
      logHookLine('session-start', 'wake-up parse error: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  matched.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.slug.localeCompare(right.slug),
  );

  const wikiChunks = matched
    .map((entry) => `## ${entry.slug} (${entry.updatedAt})\n${entry.understanding}\n\n`)
    .join('');

  let identity = null;
  try {
    const identityPath = join(kbRoot, 'identity.md');
    if (existsSync(identityPath)) {
      identity = readFileSync(identityPath, 'utf-8').trimEnd();
    }
  } catch (error) {
    logHookLine('session-start', 'wake-up parse error: ' + (error instanceof Error ? error.message : String(error)));
  }

  if (identity === null || identity.length === 0) {
    return wikiChunks.length === 0 ? null : wikiChunks;
  }
  return `${identity}\n\n${wikiChunks}`;
}
