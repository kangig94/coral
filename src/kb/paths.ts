import { isAbsolute, join, relative, resolve } from 'node:path';
import type { BuildFlavor } from '../infra/build-flavor.js';
import { coralStateRoot, kbVaultRoot } from '../infra/path/root.js';

// eslint-disable-next-line no-control-regex -- rejects C0/C1 control chars (incl NUL) in KB slugs before they reach writeFileSync
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * KB-domain wrapper for the vault root. `customRoot` is the resolved
 * CORAL_KB_PATH value from caller's env port (path resolvers do not read
 * ambient env). Delegates to `infra/path/root.ts:kbVaultRoot` so KB and
 * the CoralPaths composer share identical override semantics.
 */
export function kbRoot(flavor: BuildFlavor, customRoot?: string, baseDir?: string): string {
  return kbVaultRoot(flavor, {
    ...(baseDir === undefined ? {} : { baseDir }),
    ...(customRoot === undefined ? {} : { customRoot }),
  });
}

/** Strip trailing `.md` extension if present. Idempotent. */
export function stripMdExt(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

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
  const normalizedName = stripMdExt(name);
  if (CONTROL_CHARACTER_PATTERN.test(normalizedName)) {
    throw new Error(`${label} cannot contain control characters`);
  }
  return assertWithin(root, resolve(root, `${normalizedName}.md`), label);
}

export function notesDir(root: string): string {
  return join(root, 'notes');
}

export function wikiDir(root: string): string {
  return join(root, 'wiki');
}

export function principlesDir(root: string): string {
  return join(root, 'principles');
}

export function communitiesDir(root: string): string {
  return join(root, 'communities');
}

// KB runtime artifacts belong to the one account-neutral daemon state tree.
export function kbRuntimeDir(flavor: BuildFlavor): string {
  return join(coralStateRoot(), flavor === 'dev' ? 'data-dev' : 'data', 'kb');
}

export function sourcesDir(root: string): string {
  return join(root, 'sources');
}

export function memoDir(projectDataDir: string): string {
  return join(projectDataDir, 'memo');
}

export function memoPathFromContext(projectDataDir: string, memo: string): string {
  const root = memoDir(projectDataDir);
  return assertWithin(root, resolve(root, memo), 'Memo path');
}

export function notePathFromName(note: string, root: string): string {
  return markdownPath(notesDir(root), note, 'KB note path');
}

export function wikiPathFromName(slug: string, root: string): string {
  return markdownPath(wikiDir(root), slug, 'KB wiki path');
}

export function principlePathFromName(principle: string, root: string): string {
  return markdownPath(principlesDir(root), principle, 'KB principle path');
}

export function communityPathFromName(community: string, root: string): string {
  return markdownPath(communitiesDir(root), community, 'KB community path');
}

export function sourcePathFromName(source: string, root: string): string {
  return markdownPath(sourcesDir(root), source, 'KB source path');
}

export function sourceImportStageDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'source-import-staging');
}

export type KbRuntimePaths = {
  notesDir(): string;
  wikiDir(): string;
  sourcesDir(): string;
  communitiesDir(): string;
  principlesDir(): string;
  entityGraphPath(): string;
  notePath(note: string): string;
  wikiPath(slug: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  sourceImportStageDir(): string;
};

export function createKbRuntimePaths(markdownRoot: string, runtimeDir: string): KbRuntimePaths {
  return {
    notesDir: () => notesDir(markdownRoot),
    wikiDir: () => wikiDir(markdownRoot),
    sourcesDir: () => sourcesDir(markdownRoot),
    communitiesDir: () => communitiesDir(markdownRoot),
    principlesDir: () => principlesDir(markdownRoot),
    entityGraphPath: () => join(markdownRoot, '.entity-graph.json'),
    notePath: (note) => notePathFromName(note, markdownRoot),
    wikiPath: (slug) => wikiPathFromName(slug, markdownRoot),
    sourcePath: (source) => sourcePathFromName(source, markdownRoot),
    communityPath: (community) => communityPathFromName(community, markdownRoot),
    principlePath: (principle) => principlePathFromName(principle, markdownRoot),
    sourceImportStageDir: () => sourceImportStageDir(runtimeDir),
  };
}
