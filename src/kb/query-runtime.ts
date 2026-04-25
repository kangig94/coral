import type { Database } from 'better-sqlite3';

import { kbRoot } from "./paths.js";
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

let cachedQueryRuntime: { flavor: BuildFlavor; runtime: ReturnType<typeof createRealRuntime> } | undefined;
let cachedQueryDb: { flavor: BuildFlavor; db: Database } | undefined;

function getQueryRuntime(flavor: BuildFlavor): ReturnType<typeof createRealRuntime> {
  if (cachedQueryRuntime?.flavor !== flavor) {
    cachedQueryRuntime = { flavor, runtime: createRealRuntime(flavor) };
  }
  return cachedQueryRuntime.runtime;
}

export function resolveQueryFlavor(context: KbQueryContext = {}): BuildFlavor {
  return readBuildFlavor(context.pluginRoot ?? process.cwd());
}

export function resolveQueryProjectRoot(context: KbQueryContext = {}): string {
  return context.projectRoot ?? process.cwd();
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
  const flavor = resolveQueryFlavor(context);
  if (cachedQueryDb?.flavor !== flavor) {
    cachedQueryDb = { flavor, db: openBackendStoreDb(getQueryRuntime(flavor)) };
  }
  return cachedQueryDb.db;
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
