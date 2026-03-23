import { isAbsolute, join, relative, resolve } from 'node:path';
import { coralRoot, kbRoot, projectDataDir } from '../client/paths.js';

function assertWithin(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error(`${label} must stay within ${resolvedRoot}`);
}

export function notesDir(): string {
  return join(kbRoot(), 'notes');
}

export function principlesDir(): string {
  return join(kbRoot(), 'principles');
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

export function notePathFromParts(domain: string, topic: string): string {
  const root = notesDir();
  return assertWithin(root, resolve(root, `${domain}-${topic}.md`), 'KB note path');
}

export function notePathFromName(note: string): string {
  const root = notesDir();
  return assertWithin(root, resolve(root, `${note}.md`), 'KB note path');
}
