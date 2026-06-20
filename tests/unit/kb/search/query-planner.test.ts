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
  it("maps text intent with scope='communities' to only lexical text roles", () => {
    const queryPlan = plan('text', 'communities', [textRole(), vectorRole(), graphRole()]);

    expect(queryPlan.primaryInvocations.map((invocation) => invocation.registeredRole.descriptor.id)).toEqual(['text']);
    expect(queryPlan.primaryInvocations.map((invocation) => invocation.required)).toEqual([true]);
  });

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

  it("maps hybrid intent with scope='notes' to all three built-ins in registry order", () => {
    const roles = [textRole(), vectorRole(), graphRole()];
    const queryPlan = plan('hybrid', 'notes', roles);

    expect(queryPlan.primaryInvocations.map((invocation) => invocation.registeredRole.descriptor.id)).toEqual([
      'text',
      'vector',
      'graph',
    ]);
    expect(queryPlan.primaryInvocations.map((invocation) => invocation.required)).toEqual([true, true, false]);
  });

  it('maps hybrid intent with an empty registry to no primary invocations', () => {
    expect(plan('hybrid', 'all', [])).toEqual({ primaryInvocations: [] });
  });

  it('maps vector intent with an empty registry to no primary or fallback invocations', () => {
    expect(plan('vector', 'all', [])).toEqual({ primaryInvocations: [] });
  });

  it('preserves registry order after eligibility filtering', () => {
    const queryPlan = plan('hybrid', 'all', [graphRole(), textRole(), vectorRole()]);

    expect(queryPlan.primaryInvocations.map((invocation) => invocation.registeredRole.descriptor.id)).toEqual([
      'graph',
      'text',
      'vector',
    ]);
  });

  it("maps auto intent with scope='communities' to lexical-only eligibility", () => {
    const queryPlan = plan('auto', 'communities', [textRole(), vectorRole(), graphRole()]);

    expect(queryPlan.primaryInvocations.map((invocation) => invocation.registeredRole.descriptor.id)).toEqual(['text']);
  });

  it("maps auto intent with scope='all' to optional semantic and structural contributors", () => {
    const queryPlan = plan('auto', 'all', [textRole(), vectorRole(), graphRole()]);

    expect(queryPlan.primaryInvocations.map((invocation) => invocation.registeredRole.descriptor.id)).toEqual([
      'text',
      'vector',
      'graph',
    ]);
    expect(queryPlan.primaryInvocations.map((invocation) => invocation.required)).toEqual([true, false, false]);
  });

  it('preserves graph eligibility only for notes, sources, and all while skipping semantic and graph for communities', () => {
    for (const scope of ['notes', 'sources', 'all'] satisfies KbSearchScope[]) {
      expect(
        plan('hybrid', scope, [textRole(), vectorRole(), graphRole()]).primaryInvocations.map(
          (invocation) => invocation.registeredRole.descriptor.id,
        ),
      ).toEqual(['text', 'vector', 'graph']);
    }

    expect(
      plan('hybrid', 'communities', [textRole(), vectorRole(), graphRole()]).primaryInvocations.map(
        (invocation) => invocation.registeredRole.descriptor.id,
      ),
    ).toEqual(['text']);
  });

  it("derives required only from criticality === 'core' and the primary descriptor tag", () => {
    const lexicalCore = registeredRole('lexical-core', ['lexical', 'semantic'], ['all'], { criticality: 'core' });
    const lexicalSecondary = registeredRole('lexical-secondary', ['semantic', 'lexical'], ['all'], {
      criticality: 'core',
    });
    const lexicalExternal = registeredRole('lexical-external', ['lexical'], ['all'], { origin: 'external' });
    const structuralBuiltin = registeredRole('structural-builtin', ['structural'], ['all']);
    const queryPlan = plan('text', 'all', [lexicalCore, lexicalSecondary, lexicalExternal, structuralBuiltin]);

    expect(
      queryPlan.primaryInvocations.map((invocation) => [invocation.registeredRole.descriptor.id, invocation.required]),
    ).toEqual([
      ['lexical-core', true],
      ['lexical-secondary', false],
      ['lexical-external', false],
    ]);
  });
});
