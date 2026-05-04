import { nowIsoString } from '../../../infra/time.js';
import { captureWikiManifestDeltas } from '../../corpus/manifest-authority.js';
import { extractBody, parseWikiBody, parseWikiFrontmatter, serializeWiki } from '../../corpus/frontmatter.js';
import { commitCorpusEntryLocked } from '../../corpus/index-mutations.js';
import { buildWikiIndexEntry } from '../../corpus/index-records.js';
import { extractKnowledgeLinks } from '../../corpus/wiki-links.js';
import {
  entryIdToVaultLink,
  parseKbEntryId,
  setEntry,
  vaultLinkToEntryId,
  wikiEntryId,
  type KbEntryId,
  type KbWikiFrontmatter,
} from '../../entry-types.js';
import { currentEntrySeq } from '../../index-state.js';
import { assertNonEmptyText, assertString, assertWikiSlug } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';

/** Accepts both snake_case (wire format) and camelCase (TS convenience) for `references_principles` / `referencesPrinciples`. */
export type KbWikiCreateInput = {
  slug: string;
  title?: string;
  understanding?: string;
  knowledge?: string | readonly string[];
  tags?: readonly string[];
  references_principles?: readonly string[];
  referencesPrinciples?: readonly string[];
  related?: readonly string[];
};

export type KbWikiCreateResponse = {
  slug: string;
  path: string;
};

function normalizeStringList(values: readonly string[] | undefined, field: string): string[] {
  return (values ?? []).map((value) => assertNonEmptyText(value, field));
}

function normalizeEntryReference(value: string, field: string): KbEntryId {
  const trimmed = assertNonEmptyText(value, field);
  const entryId = parseKbEntryId(trimmed) ?? vaultLinkToEntryId(trimmed);
  if (entryId === null) {
    throw new Error(`${field} must be a KB entry ID or vault-relative wikilink`);
  }
  return entryId;
}

function normalizeEntryReferences(values: readonly string[] | undefined, field: string): KbEntryId[] {
  return (values ?? []).map((value) => normalizeEntryReference(value, field));
}

function normalizeKnowledgeSection(value: string | readonly string[] | undefined): string {
  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return assertString(value, 'knowledge').trim();
  }

  return value.map((link) => `- ${entryIdToVaultLink(normalizeEntryReference(link, 'knowledge'))}`).join('\n');
}

function buildWikiBody(input: Pick<KbWikiCreateInput, 'understanding' | 'knowledge'>): string {
  const understanding =
    input.understanding === undefined ? '' : assertString(input.understanding, 'understanding').trim();
  const knowledge = normalizeKnowledgeSection(input.knowledge);

  return `## Understanding

${understanding}

## Knowledge

${knowledge}`;
}

function parseWikiIndexPayload(
  slug: string,
  raw: string,
): KbWikiFrontmatter & { title: string; knowledge: KbEntryId[] } {
  const frontmatter = parseWikiFrontmatter(raw);
  const body = extractBody(raw);
  const sections = parseWikiBody(body);
  return {
    ...frontmatter,
    title: assertNonEmptyText(raw.match(/^# (.+)$/m)?.[1] ?? slug, 'title'),
    knowledge: extractKnowledgeLinks(sections.knowledge),
  };
}

export async function createWiki(rt: KbRuntime, input: KbWikiCreateInput): Promise<KbWikiCreateResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const title = input.title === undefined ? slug : assertNonEmptyText(input.title, 'title');
  const wikiPath = rt.wikiPath(slug);

  return rt.withMutationLock(async (mutation) => {
    if (rt.storagePort.existsSync(wikiPath)) {
      throw new Error(`KB wiki already exists: ${wikiPath}`);
    }

    const createdAt = nowIsoString(rt.time);
    const meta: KbWikiFrontmatter = {
      tags: normalizeStringList(input.tags, 'tags'),
      references_principles: normalizeStringList(
        input.references_principles ?? input.referencesPrinciples,
        'references_principles',
      ),
      createdAt,
      updatedAt: createdAt,
      entrySeq: currentEntrySeq(rt.readIndexState()) + 1,
      related: normalizeEntryReferences(input.related, 'related'),
    };
    const raw = serializeWiki(meta, title, buildWikiBody(input));
    const parsed = parseWikiIndexPayload(slug, raw);

    commitCorpusEntryLocked(rt, mutation, {
      path: wikiPath,
      raw,
      manifestDeltas: captureWikiManifestDeltas(slug, raw),
      indexUpdate: (index) => {
        setEntry(
          index,
          wikiEntryId(slug),
          buildWikiIndexEntry({
            slug,
            ...parsed,
          }),
        );
      },
      lane: 'both',
      reason: 'KB text snapshot is stale after kb_wiki_create.',
    });

    return { slug, path: wikiPath };
  });
}
