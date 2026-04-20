import { existsSync, readFileSync } from 'node:fs';

import { createKbRuntime } from '../../kb/runtime.js';
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
} from '../../kb/entry-types.js';
import { isNoteEntry } from '../../kb/entry-types.js';
import {
  buildKbDiagnoseResult,
  handleKbRead,
  kbPrinciplesSchema,
  kbSearchSchema,
} from '../../kb/api.js';
import { readCurateRetryQueue } from '../../kb/curate/retry.js';
import { listMemos } from '../../kb/ops/memo.js';
import { searchKb } from '../../kb/ops/search.js';
import { listSources } from '../../kb/ops/source-store.js';
import { closeNeedleBackend } from '../../kb/search/needle-backend.js';
import { compareLocale } from '../../kb/validation.js';
import { kbRuntimeDir } from '../../kb/paths.js';
import { kbRoot } from '../../infra/paths.js';
import { createRealRuntime } from '../../runtime/real.js';
import { openBackendStoreDb } from '../db.js';
import { readBuildFlavor } from '../../shared/utils.js';
import type { CallerContext } from '../../shared/request-context.js';
import type { ToolDomainResult } from '../../shared/tool-domain-result.js';

type KbQueryContext = {
  projectRoot?: string;
  pluginRoot?: string;
};

const EMPTY_CALLER_CONTEXT: Omit<CallerContext, 'projectRoot'> = {
  pluginRoot: '',
  coralEnv: {},
};

let sharedKbQueryDb: ReturnType<typeof openBackendStoreDb> | null = null;

function unwrapDomainResult<T>(result: ToolDomainResult): T {
  if (result.ok) {
    return result.data as T;
  }

  throw new Error(result.message);
}

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
  const parsed = kbSearchSchema.parse(args);
  const kb = createKbQueryRuntime();

  try {
    void context;
    return await searchKb(kb, parsed.query, parsed.top_k ?? 20, parsed.scope ?? 'all', parsed.mode);
  } finally {
    await closeNeedleBackend(kb);
  }
}

export function readKnowledgeBaseEntry(
  selector: KbReadInput,
  context: KbQueryContext = {},
): KbReadResult {
  const projectRoot = context.projectRoot ?? process.cwd();
  return unwrapDomainResult<KbReadResult>(
    handleKbRead(
      selector as Record<string, unknown>,
      {
        ...EMPTY_CALLER_CONTEXT,
        projectRoot,
      },
      {
        storage: {
          existsSync: (filePath) => existsSync(filePath),
          readFileSync: (filePath, encoding) => readFileSync(filePath, encoding),
        },
      },
    ),
  );
}

export async function listKnowledgeBasePrinciples(
  args: KbPrinciplesInput,
): Promise<KbPrinciplesResult> {
  const parsed = kbPrinciplesSchema.parse(args);
  const kb = createKbQueryRuntime();

  try {
    const index = await kb.ensureIndex();
    const allNames = Object.keys(index.principles).sort(compareLocale);
    const total = allNames.length;
    let names = allNames;

    if (parsed.query?.trim()) {
      const loweredQuery = parsed.query.toLowerCase();
      names = allNames.filter((name) => name.toLowerCase().includes(loweredQuery));
    }

    names = names.slice(0, parsed.top_k ?? 100);
    if (parsed.verbose !== true) {
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
