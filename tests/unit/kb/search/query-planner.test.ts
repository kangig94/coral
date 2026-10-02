import { describe, expect, it } from 'vitest';

import type { KbSearchScope } from '#src/kb/entry-types.js';
import { createQueryPlanner, type KbSearchIntent } from '#src/kb/search/query-planner.js';
import type {
  RegisteredRetrievalRole,
  RetrievalRoleDescriptor,
  RoleExecutionRegistryView,
  RoleQueryContext,
} from '#src/kb/search/contract.js';

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

function registeredRole(
  id: string,
  tags: readonly string[],
  supportsScopes: readonly KbSearchScope[],
  options: {
    readonly origin?: RegisteredRetrievalRole['origin'];
    readonly criticality?: RegisteredRetrievalRole['criticality'];
  } = {},
): RegisteredRetrievalRole {
  const roleDescriptor = descriptor(id, tags, supportsScopes);
  return {
    role: {
      id,
      descriptor: roleDescriptor,
      async search() {
        return { hits: [] };
      },
    },
    descriptor: roleDescriptor,
    origin: options.origin ?? 'builtin',
    permanence: options.origin === 'external' ? 'scoped' : 'runtime',
    ...(options.criticality === undefined ? {} : { criticality: options.criticality }),
  };
}

const textRole = () =>
  registeredRole('text', ['lexical'], ['notes', 'sources', 'communities', 'all'], { criticality: 'core' });
const vectorRole = () => registeredRole('vector', ['semantic'], ['notes', 'sources', 'all'], { criticality: 'core' });
const graphRole = () => registeredRole('graph', ['structural'], ['notes', 'sources', 'all']);

function plan(intent: KbSearchIntent, scope: KbSearchScope, roles: readonly RegisteredRetrievalRole[]) {
  const registry: RoleExecutionRegistryView = {
    list: () => roles,
  };
  const ctx = {
    rawQuery: 'query',
    topK: 5,
    scope,
    signal: new AbortController().signal,
    normalizedQuery: () => 'query',
    tokens: async () => ['query'],
    embedding: async () => new Float32Array([1]),
    index: () => ({ entries: {}, principles: {}, entityMeta: {}, relationships: [] }),
    corpusStructuralKey: () => null,
    graphContext: () => null,
  } satisfies RoleQueryContext;
  return createQueryPlanner().plan(intent, registry, ctx);
}

describe('query planner role selection', () => {
  it("maps vector intent with scope='all' to semantic primary roles and lazy lexical fallback", () => {
    const queryPlan = plan('vector', 'all', [textRole(), vectorRole(), graphRole()]);

    expect(queryPlan.primaryInvocations.map((invocation) => invocation.registeredRole.descriptor.id)).toEqual([
      'vector',
    ]);
    expect(queryPlan.primaryInvocations.map((invocation) => invocation.required)).toEqual([true]);
    expect(queryPlan.fallbackInvocations?.map((invocation) => invocation.registeredRole.descriptor.id)).toEqual([
      'text',
    ]);
    expect(queryPlan.fallbackInvocations?.map((invocation) => invocation.required)).toEqual([false]);
  });
});
