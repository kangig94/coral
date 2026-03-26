import { readFileSync } from 'node:fs';
import { extractBody, parseFrontmatter, extractTitle } from './frontmatter.js';
import { notePathFromName } from './paths.js';
import type { KbReadInput } from './contracts.js';
import { assertSlug } from './mutation-helpers.js';

export type KbReadResult = {
  note: string;
  title: string;
  content: string;
  tags: string[];
  principles: string[];
};

export function readNote(input: KbReadInput): KbReadResult {
  const note = assertSlug(input.note, 'note');
  const notePath = notePathFromName(note);
  const raw = readFileSync(notePath, 'utf-8');
  const frontmatter = parseFrontmatter(raw);

  return {
    note,
    title: extractTitle(raw),
    content: extractBody(raw),
    tags: frontmatter.tags,
    principles: frontmatter.principles,
  };
}
