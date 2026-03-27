import { isAbsolute, join, relative, resolve } from 'node:path';
import { coralRoot, kbRoot, projectDataDir } from '../infra/paths.js';

export function assertWithin(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error(`${label} must stay within ${resolvedRoot}`);
}

function markdownPath(root: string, name: string, label: string): string {
  return assertWithin(root, resolve(root, `${name}.md`), label);
}

export function notesDir(root: string = kbRoot()): string {
  return join(root, 'notes');
}

export function principlesDir(root: string = kbRoot()): string {
  return join(root, 'principles');
}

export function kbRuntimeDir(): string {
  return join(coralRoot(), 'data', 'kb');
}

export function memoDir(projectRoot: string): string {
  return join(projectDataDir(projectRoot), 'memo');
}

export function memoPathFromContext(projectRoot: string, memo: string): string {
  const root = memoDir(projectRoot);
  return assertWithin(root, resolve(root, memo), 'Memo path');
}

export function notePathFromParts(domain: string, topic: string, root: string = kbRoot()): string {
  return notePathFromName(`${domain}-${topic}`, root);
}

export function notePathFromName(note: string, root: string = kbRoot()): string {
  return markdownPath(notesDir(root), note, 'KB note path');
}

export function principlePathFromName(principle: string, root: string = kbRoot()): string {
  return markdownPath(principlesDir(root), principle, 'KB principle path');
}
