import { isAbsolute, join, relative, resolve } from 'node:path';
import type { BuildFlavor } from '../infra/build-flavor.js';
import { coralRoot, kbVaultRoot } from '../infra/path/root.js';
import { projectDataDir } from '../infra/project-source.js';

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
  return assertWithin(root, resolve(root, `${stripMdExt(name)}.md`), label);
}

export function notesDir(root: string): string {
  return join(root, 'notes');
}

export function principlesDir(root: string): string {
  return join(root, 'principles');
}

export function communitiesDir(root: string): string {
  return join(root, 'communities');
}

export function kbRuntimeDir(flavor: BuildFlavor): string {
  return join(coralRoot(), flavor === 'dev' ? 'data-dev' : 'data', 'kb');
}

export function oramaSnapshotDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'orama');
}

export function needleIndexDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle');
}

export function needleStagingDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'needle-staging');
}

export function sourcesDir(root: string): string {
  return join(root, 'sources');
}

export function memoDir(projectRoot: string): string {
  return join(projectDataDir(projectRoot), 'memo');
}

export function memoPathFromContext(projectRoot: string, memo: string): string {
  const root = memoDir(projectRoot);
  return assertWithin(root, resolve(root, memo), 'Memo path');
}

export function notePathFromParts(domain: string, topic: string, root: string): string {
  return notePathFromName(`${domain}-${topic}`, root);
}

export function notePathFromName(note: string, root: string): string {
  return markdownPath(notesDir(root), note, 'KB note path');
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
  sourcesDir(): string;
  communitiesDir(): string;
  principlesDir(): string;
  entityGraphPath(): string;
  notePath(note: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  sourceImportStageDir(): string;
};

export function createKbRuntimePaths(markdownRoot: string, runtimeDir: string): KbRuntimePaths {
  return {
    notesDir: () => notesDir(markdownRoot),
    sourcesDir: () => sourcesDir(markdownRoot),
    communitiesDir: () => communitiesDir(markdownRoot),
    principlesDir: () => principlesDir(markdownRoot),
    entityGraphPath: () => join(markdownRoot, '.entity-graph.json'),
    notePath: (note) => notePathFromName(note, markdownRoot),
    sourcePath: (source) => sourcePathFromName(source, markdownRoot),
    communityPath: (community) => communityPathFromName(community, markdownRoot),
    principlePath: (principle) => principlePathFromName(principle, markdownRoot),
    sourceImportStageDir: () => sourceImportStageDir(runtimeDir),
  };
}
