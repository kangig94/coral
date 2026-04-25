import type { Database } from 'better-sqlite3';

import { kbRoot } from '../infra/paths.js';
import { readBuildFlavor } from '../infra/bundle-manifest.js';
import { createRealRuntime } from '../runtime/real.js';
import { openBackendStoreDb } from '../store/db.js';
import type { BuildFlavor } from '../infra/build-flavor.js';
import type { KbRuntime } from './contracts.js';
import {
  communityPathFromName,
  kbRuntimeDir,
  notePathFromName,
  principlePathFromName,
  sourcePathFromName,
} from './paths.js';
import { createKbRuntime } from './runtime.js';
import type { KbReadPathResolver } from './read.js';

export type KbQueryContext = {
  projectRoot?: string;
  pluginRoot?: string;
};

let queryRuntime: ReturnType<typeof createRealRuntime> | null = null;
const queryDbsByFlavor = new Map<BuildFlavor, Database>();

function getQueryRuntime(): ReturnType<typeof createRealRuntime> {
  queryRuntime ??= createRealRuntime();
  return queryRuntime;
}

export function resolveQueryFlavor(context: KbQueryContext = {}): BuildFlavor {
  const runtime = getQueryRuntime();
  return readBuildFlavor(context.pluginRoot ?? runtime.env.cwd());
}

export function resolveQueryProjectRoot(context: KbQueryContext = {}): string {
  return context.projectRoot ?? getQueryRuntime().env.cwd();
}

export function resolveQueryMarkdownRoot(context: KbQueryContext = {}): string {
  return kbRoot(resolveQueryFlavor(context));
}

export function createDefaultKbReadPaths(context: KbQueryContext = {}): KbReadPathResolver {
  const root = resolveQueryMarkdownRoot(context);
  return {
    notePath: (note) => notePathFromName(note, root),
    sourcePath: (source) => sourcePathFromName(source, root),
    communityPath: (community) => communityPathFromName(community, root),
    principlePath: (principle) => principlePathFromName(principle, root),
  };
}

export function getDefaultKbQueryDb(context: KbQueryContext = {}): Database {
  const runtime = getQueryRuntime();
  const flavor = resolveQueryFlavor(context);
  const existing = queryDbsByFlavor.get(flavor);
  if (existing !== undefined) {
    return existing;
  }

  const db = openBackendStoreDb(runtime, flavor);
  queryDbsByFlavor.set(flavor, db);
  return db;
}

export function createDefaultKbQueryRuntime(context: KbQueryContext = {}): KbRuntime {
  const flavor = resolveQueryFlavor(context);
  return createKbRuntime({
    markdownRoot: resolveQueryMarkdownRoot(context),
    runtimeDir: kbRuntimeDir(flavor),
    db: getDefaultKbQueryDb(context),
    readOnlyOrama: true,
  });
}
