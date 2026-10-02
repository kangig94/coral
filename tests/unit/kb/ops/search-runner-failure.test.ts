import { describe, expect, it, vi } from 'vitest';

import type { Backed, FtsRetrieval, KbRuntime } from '#src/kb/contract.js';
import type { KbIndex, KbSearchScope } from '#src/kb/entry-types.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  KB_EMBEDDING_CAPABILITY,
  KB_FTS_CAPABILITY,
  KB_VECTOR_CAPABILITY,
} from '#src/kb/capability/constants.js';
import { createCapabilityRegistry } from '#src/kb/capability/registry.js';
import { createSearchRequest, runRetrieval } from '#src/kb/ops/search-runner.js';
import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import type { RetrievalHit, RetrievalRole, RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';

function noteHit(slug: string): RetrievalHit {
  const entryId = `note:${slug}` as const;
  return {
    entryId,
    slug,
    kind: 'note',
    title: slug,
    tags: [],
    principles: [],
    rank: 1,
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
  search: RetrievalRole['search'],
): RetrievalRole {
  const roleDescriptor = descriptor(id, tags, supportsScopes);
  return {
    id,
    descriptor: roleDescriptor,
    search: vi.fn(search),
  };
}

function indexFor(slug = 'fallback-text'): KbIndex {
  return {
    entries: {
      [`note:${slug}`]: {
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
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  };
}

function runtimeWith(
  roles: readonly { readonly role: RetrievalRole; readonly criticality?: 'core' }[],
  ftsWarnings: readonly string[] = [],
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
      return ftsWarnings;
    },
  };
  const backedFts: Backed<FtsRetrieval> = {
    read: () => fts,
    consumer: { id: 'failure-test-fts', kind: 'stateless', registrationKind: 'stateless' },
  };
  const capabilityRegistry = createCapabilityRegistry();
  capabilityRegistry.registerBuiltin(
    BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
    createRuntimeBinding<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY),
  );
  capabilityRegistry.registerBuiltin(BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR, createRuntimeBinding(KB_VECTOR_CAPABILITY));
  capabilityRegistry.registerBuiltin(
    BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
    createRuntimeBinding(KB_EMBEDDING_CAPABILITY),
  );
  capabilityRegistry.runtimeView().bind(KB_FTS_CAPABILITY, backedFts, { [Symbol.dispose]() {} }, 'failure-test');

  return {
    roleRegistry,
    capabilityRegistry,
    readIndex: () => indexFor(),
    readIndexOrEmpty: () => indexFor(),
    readEntityGraph: () => null,
    readCorpusStructuralKey: () => null,
  } as unknown as KbRuntime;
}

describe('search runner role failure isolation', () => {
  it('Rule 1 rethrows required vector setup failures and does not fire lazy text fallback', async () => {
    const text = role('text', ['lexical'], ['notes', 'sources', 'communities', 'all'], async () => ({
      hits: [noteHit('fallback-text')],
    }));
    const vector = role('vector', ['semantic'], ['notes', 'sources', 'all'], async () => {
      throw documentedCoralSetupError('binding_empty', { binding: 'kb.embedding' });
    });
    const rt = runtimeWith([
      { role: text, criticality: 'core' },
      { role: vector, criticality: 'core' },
    ]);

    await expect(runRetrieval(rt, createSearchRequest('semantic', 5, 'all', 'vector'))).rejects.toMatchObject({
      code: 'binding_empty',
      userMessage: 'Vector search needs kb.embedding.',
      context: { binding: 'kb.embedding' },
    });
    expect(vector.search).toHaveBeenCalledTimes(1);
    expect(text.search).not.toHaveBeenCalled();
  });

  it('Rule 3 isolates optional vector setup failures under auto intent without public warning text', async () => {
    const text = role('text', ['lexical'], ['notes', 'sources', 'communities', 'all'], async () => ({
      hits: [noteHit('fallback-text')],
    }));
    const vector = role('vector', ['semantic'], ['notes', 'sources', 'all'], async () => {
      throw documentedCoralSetupError('binding_empty', { binding: 'kb.embedding' });
    });
    const rt = runtimeWith([
      { role: text, criticality: 'core' },
      { role: vector, criticality: 'core' },
    ]);

    const response = await runRetrieval(rt, createSearchRequest('semantic', 5, 'all', 'auto'));

    expect(response.mode).toBe('text');
    expect(response.results.map((result) => result.note)).toEqual(['fallback-text']);
    expect(response.retrievalDiagnostics).toEqual([
      {
        roleId: 'vector',
        code: 'binding_missing',
        recoverable: true,
      },
    ]);
  });
});
