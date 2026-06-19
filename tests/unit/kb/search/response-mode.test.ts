import { describe, expect, it, vi } from 'vitest';

import type { Backed, FtsRetrieval, KbRuntime } from '#src/kb/contract.js';
import type { KbIndex, KbSearchScope } from '#src/kb/entry-types.js';
import { createSearchRequest, runRetrieval } from '#src/kb/ops/search-runner.js';
import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import type {
  RetrievalHit,
  RetrievalRole,
  RetrievalRoleDescriptor,
  RoleSearchResult,
} from '#src/kb/search/contract.js';

function noteHit(slug: string, rank = 1): RetrievalHit {
  const entryId = `note:${slug}` as const;
  return {
    entryId,
    slug,
    kind: 'note',
    title: slug,
    tags: [],
    principles: [],
    rank,
    score: 1,
    document: {
      entryId,
      slug,
      kind: 'note',
      freshness: 'fresh',
      title: slug,
      body: `${slug} body`,
      tags: [],
      principles: [],
    },
  };
}

function vectorHit(slug: string, rank = 1): RetrievalHit {
  const { document: _document, ...hit } = noteHit(slug, rank);
  return hit;
}

function descriptor(
  id: string,
  tags: readonly string[],
  supportsScopes: readonly KbSearchScope[],
): RetrievalRoleDescriptor {
  return {
    id,
    label: id,
    tags: [...tags],
    phase: 'retrieval-source',
    supportsScopes: [...supportsScopes],
    provides: 'retrieval-source',
  };
}

function role(
  id: string,
  tags: readonly string[],
  supportsScopes: readonly KbSearchScope[],
  search: () => RoleSearchResult | Promise<RoleSearchResult>,
): RetrievalRole {
  const roleDescriptor = descriptor(id, tags, supportsScopes);
  return {
    id,
    descriptor: roleDescriptor,
    search: vi.fn(async () => await search()),
  };
}

function indexFor(slugs: readonly string[]): KbIndex {
  return {
    entries: Object.fromEntries(
      slugs.map((slug) => [
        `note:${slug}`,
        {
          kind: 'note',
          slug,
          title: slug,
          tags: [],
          principles: [],
          source: [],
          createdAt: '2026-05-03',
          updatedAt: '2026-05-03',
          bodyHash: `${slug}-body-hash`,
        },
      ]),
    ),
    principles: {},
    entityMeta: {},
    relationships: [],
  };
}

function testRuntime(
  roles: readonly { readonly role: RetrievalRole; readonly criticality?: 'core' }[],
  index: KbIndex,
): KbRuntime {
  const roleRegistry = createRoleRegistry();
  for (const item of roles) {
    roleRegistry.registerBuiltin(
      item.role,
      item.criticality === undefined ? undefined : { criticality: item.criticality },
    );
  }

  const fts: FtsRetrieval = {
    async search() {
      return { hits: [], exhausted: true };
    },
    async tokenize(text) {
      return text.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    },
    warnings() {
      return [];
    },
  };
  const backedFts: Backed<FtsRetrieval> = {
    read: () => fts,
    consumer: { id: 'test-fts', kind: 'stateless', registrationKind: 'stateless' },
  };

  return {
    roleRegistry,
    fts: {
      read: () => backedFts,
      heldBy: 'test',
    },
    readIndex: () => index,
    readIndexOrEmpty: () => index,
    readEntityGraph: () => null,
    readCorpusStructuralKey: () => null,
  } as unknown as KbRuntime;
}

async function search(
  roles: readonly { readonly role: RetrievalRole; readonly criticality?: 'core' }[],
  mode: 'auto' | 'text' | 'vector' | 'hybrid',
  scope: KbSearchScope,
  slugs: readonly string[],
) {
  return await runRetrieval(testRuntime(roles, indexFor(slugs)), createSearchRequest('response mode', 5, scope, mode));
}

describe('response mode derivation by intent', () => {
  it("preserves explicit hybrid mode for scope='communities' when no semantic role is eligible", async () => {
    const text = role('text', ['lexical'], ['notes', 'sources', 'communities', 'all'], () => ({
      hits: [noteHit('hybrid-community')],
    }));
    const vector = role('vector', ['semantic'], ['notes', 'sources', 'all'], () => ({ hits: [vectorHit('semantic')] }));
    const graph = role('graph', ['structural'], ['notes', 'sources', 'all'], () => ({ hits: [vectorHit('graph')] }));

    const response = await search(
      [{ role: text, criticality: 'core' }, { role: vector, criticality: 'core' }, { role: graph }],
      'hybrid',
      'communities',
      ['hybrid-community', 'semantic', 'graph'],
    );

    expect(response.mode).toBe('hybrid');
    expect(response.results.map((result) => result.note)).toEqual(['hybrid-community']);
    expect(response.results[0]?.evidence.map((item) => item.roleId)).toEqual(['text']);
    expect(vector.search).not.toHaveBeenCalled();
    expect(graph.search).not.toHaveBeenCalled();
  });

  it('keeps explicit hybrid mode when the topK evidence is lexical-only', async () => {
    const text = role('text', ['lexical'], ['all'], () => ({ hits: [noteHit('lexical-only')] }));

    const response = await search([{ role: text, criticality: 'core' }], 'hybrid', 'all', ['lexical-only']);

    expect(response.mode).toBe('hybrid');
    expect(response.results[0]?.evidence.map((item) => item.roleId)).toEqual(['text']);
  });

  it('promotes auto mode to hybrid when topK evidence includes a semantic contributor', async () => {
    const vector = role('vector', ['semantic'], ['all'], () => ({ hits: [vectorHit('semantic-only')] }));

    const response = await search([{ role: vector, criticality: 'core' }], 'auto', 'all', ['semantic-only']);

    expect(response.mode).toBe('hybrid');
    expect(response.results[0]?.evidence.map((item) => item.roleId)).toEqual(['vector']);
  });

  it('keeps auto mode as text when topK evidence is structural-only graph evidence', async () => {
    const graph = role('graph', ['structural'], ['all'], () => ({ hits: [vectorHit('graph-only')] }));

    const response = await search([{ role: graph }], 'auto', 'all', ['graph-only']);

    expect(response.mode).toBe('text');
    expect(response.results[0]?.evidence.map((item) => item.roleId)).toEqual(['graph']);
  });

  it('always returns text mode for explicit text intent', async () => {
    const text = role('text', ['lexical'], ['all'], () => ({ hits: [noteHit('text-intent')] }));
    const vector = role('vector', ['semantic'], ['all'], () => ({ hits: [vectorHit('semantic-not-called')] }));

    const response = await search(
      [
        { role: text, criticality: 'core' },
        { role: vector, criticality: 'core' },
      ],
      'text',
      'all',
      ['text-intent', 'semantic-not-called'],
    );

    expect(response.mode).toBe('text');
    expect(response.results.map((result) => result.note)).toEqual(['text-intent']);
    expect(vector.search).not.toHaveBeenCalled();
  });

  it('returns vector mode for successful explicit vector intent', async () => {
    const text = role('text', ['lexical'], ['all'], () => ({ hits: [noteHit('fallback-not-called')] }));
    const vector = role('vector', ['semantic'], ['all'], () => ({ hits: [vectorHit('vector-intent')] }));

    const response = await search(
      [
        { role: text, criticality: 'core' },
        { role: vector, criticality: 'core' },
      ],
      'vector',
      'all',
      ['fallback-not-called', 'vector-intent'],
    );

    expect(response.mode).toBe('vector');
    expect(response.results.map((result) => result.note)).toEqual(['vector-intent']);
    expect(text.search).not.toHaveBeenCalled();
  });
});
