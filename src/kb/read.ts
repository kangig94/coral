import { readFileSync } from 'node:fs';
import { extractBody, parseFrontmatter, extractTitle } from './frontmatter.js';
import { notePathFromName } from './paths.js';
import type { KbNoteFrontmatter, KbReadInput } from './types.js';
import { assertNoteSlug } from './validation.js';

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

export function readNote(input: KbReadInput): KbReadResult {
  const note = assertNoteSlug(input.note, 'note');
  const { frontmatter, title, body } = loadKbNote(notePathFromName(note));

  return {
    note,
    title,
    content: body,
    tags: frontmatter.tags,
    principles: frontmatter.principles,
  };
}
