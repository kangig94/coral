import { existsSync, readFileSync } from 'node:fs';
import { extractBody, parseFrontmatter, extractTitle } from './frontmatter.js';
import { memoDir, notePathFromName } from './paths.js';
import type { KbNoteFrontmatter, KbReadInput } from './types.js';
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

export type KbReadResult = {
  note: string;
  title: string;
  content: string;
  tags: string[];
  principles: string[];
};

const MEMO_FILENAME_PATTERN = /^\d{8}-\d{6}-.+$/;

export function readEntry(input: KbReadInput, projectRoot?: string): KbReadResult {
  const note = assertNoteSlug(input.note, 'note');

  if (projectRoot && MEMO_FILENAME_PATTERN.test(note)) {
    const memoPath = join(memoDir(projectRoot), `${note}.md`);
    if (existsSync(memoPath)) {
      const raw = readFileSync(memoPath, 'utf-8');
      return {
        note,
        title: note,
        content: extractBody(raw),
        tags: [],
        principles: [],
      };
    }
  }

  const { frontmatter, title, body } = loadKbNote(notePathFromName(note));
  return {
    note,
    title,
    content: body,
    tags: frontmatter.tags,
    principles: frontmatter.principles,
  };
}
