import { join } from 'node:path';
import {
  communityPathFromName,
  communitiesDir,
  notePathFromName,
  notesDir,
  principlePathFromName,
  principlesDir,
  sourceImportStageDir,
  sourcePathFromName,
  sourcesDir,
} from './paths.js';

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
