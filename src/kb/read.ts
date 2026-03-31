import { existsSync, readFileSync } from 'node:fs';
import { extractBody, extractPrincipleStatement, extractTitle, parseFrontmatter } from './frontmatter.js';
import { memoDir, notePathFromName, principlePathFromName } from './paths.js';
import type { KbNoteFrontmatter, KbReadInput, KbReadResult } from './types.js';
import { assertNoteSlug } from './validation.js';
import { join } from 'node:path';

export type KbLoadedNote = {
  raw: string;
  frontmatter: KbNoteFrontmatter;
  title: string;
  body: string;
};

export function loadKbNote(notePath: string): KbLoadedNote {
  const raw = readFileSync(notePath, 'utf-8');
  return {
    raw,
    frontmatter: parseFrontmatter(raw),
    title: extractTitle(raw),
    body: extractBody(raw),
  };
}

const MEMO_FILENAME_PATTERN = /^\d{8}-\d{6}-.+$/;

export function readEntry(input: KbReadInput, projectRoot?: string): KbReadResult {
  const note = assertNoteSlug(input.note, 'note');

  if (projectRoot && MEMO_FILENAME_PATTERN.test(note)) {
    const memoPath = join(memoDir(projectRoot), `${note}.md`);
    if (existsSync(memoPath)) {
      const raw = readFileSync(memoPath, 'utf-8');
      return {
        kind: 'memo',
        note,
        title: note,
        content: extractBody(raw),
        tags: [],
        principles: [],
      };
    }
  }

  const notePath = notePathFromName(note);
  if (existsSync(notePath)) {
    const { frontmatter, title, body } = loadKbNote(notePath);
    return {
      kind: 'note',
      note,
      title,
      content: body,
      tags: frontmatter.tags,
      principles: frontmatter.principles,
      updatedAt: frontmatter.updatedAt,
    };
  }

  const principlePath = principlePathFromName(note);
  if (existsSync(principlePath)) {
    const raw = readFileSync(principlePath, 'utf-8');
    const updatedAtMatch = raw.match(/^updatedAt:\s*(.+)$/m);
    return {
      kind: 'principle',
      note,
      title: note,
      content: extractPrincipleStatement(raw),
      rawContent: raw,
      tags: [],
      principles: [],
      updatedAt: updatedAtMatch?.[1]?.trim(),
    };
  }

  throw new Error(`KB entry not found: ${note}`);
}
