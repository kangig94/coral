import { createKbRuntime } from './runtime.js';
import type {
  KbDiagnoseResult,
  KbMemoListInput,
  KbMemoListResult,
  KbPrincipleVerboseRow,
  KbPrinciplesInput,
  KbPrinciplesResult,
  KbReadInput,
  KbReadResult,
  KbSearchInput,
  KbSearchResponse,
  KbSourceListResult,
} from './entry-types.js';
import { isNoteEntry } from './entry-types.js';
import { buildKbDiagnoseResult } from './diagnose.js';
import { readEntry } from './read.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { listMemos } from './ops/memo.js';
import { searchKb } from './ops/search.js';
import { listSources } from './ops/source-store.js';
import { closeNeedleBackend } from './search/needle-backend.js';
import { compareLocale } from './validation.js';
import { kbRuntimeDir } from './paths.js';
import { kbRoot } from '../infra/paths.js';
import { createRealRuntime } from '../runtime/real.js';
import { openBackendStoreDb } from '../store/db.js';
import { readBuildFlavor } from '../infra/bridge-manifest.js';

type KbQueryContext = {
  projectRoot?: string;
  pluginRoot?: string;
};

let sharedKbQueryDb: ReturnType<typeof openBackendStoreDb> | null = null;

function createKbQueryRuntime(): ReturnType<typeof createKbRuntime> {
  if (sharedKbQueryDb === null) {
    const runtime = createRealRuntime();
    sharedKbQueryDb = openBackendStoreDb(runtime, readBuildFlavor(runtime.env.cwd()));
  }

  return createKbRuntime({
    markdownRoot: kbRoot(),
    runtimeDir: kbRuntimeDir(),
    db: sharedKbQueryDb,
    readOnlyOrama: true,
  });
}

export async function searchKnowledgeBase(
  args: KbSearchInput,
  context: KbQueryContext = {},
): Promise<KbSearchResponse> {
  const kb = createKbQueryRuntime();

  try {
    void context;
    return await searchKb(kb, args.query, args.top_k ?? 20, args.scope ?? 'all', args.mode);
  } finally {
    await closeNeedleBackend(kb);
  }
}

export function readKnowledgeBaseEntry(
  selector: KbReadInput,
  context: KbQueryContext = {},
): KbReadResult {
  void context.pluginRoot;
  return readEntry(selector, { projectRoot: context.projectRoot ?? process.cwd() });
}

export async function listKnowledgeBasePrinciples(
  args: KbPrinciplesInput,
): Promise<KbPrinciplesResult> {
  const kb = createKbQueryRuntime();

  try {
    const index = await kb.ensureIndex();
    const allNames = Object.keys(index.principles).sort(compareLocale);
    const total = allNames.length;
    let names = allNames;

    if (args.query?.trim()) {
      const loweredQuery = args.query.toLowerCase();
      names = allNames.filter((name) => name.toLowerCase().includes(loweredQuery));
    }

    names = names.slice(0, args.top_k ?? 100);
    if (args.verbose !== true) {
      return { principles: names, total };
    }

    const selected = new Set(names);
    const notesByPrinciple = new Map(names.map((name) => [name, [] as string[]]));
    const orphanRefs = new Set<string>();
    const noteEntries = Object.values(index.entries)
      .filter(isNoteEntry)
      .sort((left, right) => compareLocale(left.slug, right.slug));

    for (const noteRecord of noteEntries) {
      for (const principle of noteRecord.principles) {
        if (selected.has(principle)) {
          notesByPrinciple.get(principle)?.push(noteRecord.slug);
          continue;
        }

        if (!(principle in index.principles)) {
          orphanRefs.add(principle);
        }
      }
    }

    const principles: KbPrincipleVerboseRow[] = names.map((name) => ({
      name,
      statement: index.principles[name],
      notes: notesByPrinciple.get(name) ?? [],
    }));
    const warning =
      orphanRefs.size === 0 ? undefined : `Orphan principle refs: ${[...orphanRefs].sort(compareLocale).join(', ')}`;

    return {
      principles,
      total,
      ...(warning === undefined ? {} : { warning }),
    };
  } finally {
    await closeNeedleBackend(kb);
  }
}

export async function listKnowledgeBaseSources(): Promise<KbSourceListResult> {
  const kb = createKbQueryRuntime();

  try {
    return await listSources(kb);
  } finally {
    await closeNeedleBackend(kb);
  }
}

export function diagnoseKnowledgeBase(): KbDiagnoseResult {
  if (sharedKbQueryDb === null) {
    const runtime = createRealRuntime();
    sharedKbQueryDb = openBackendStoreDb(runtime, readBuildFlavor(runtime.env.cwd()));
  }

  return buildKbDiagnoseResult(readCurateRetryQueue(sharedKbQueryDb));
}

export function listKnowledgeBaseMemos(
  projectRoot: string,
  args: KbMemoListInput = {},
): KbMemoListResult {
  return listMemos(projectRoot, args.owner);
}
