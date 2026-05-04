import { describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import type { KbIndex, KbSearchScope } from '#src/kb/entry-types.js';
import { createSearchRequest, runRetrieval } from '#src/kb/ops/search-runner.js';
import { searchKnowledgeBase, type KbQueryHost } from '#src/kb/queries.js';
import { createRoleRegistry } from '#src/kb/search/role-registry.js';
import type { RetrievalRole, RetrievalRoleDescriptor } from '#src/kb/search/contract.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

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

function nonEmptyIndex(): KbIndex {
  return {
    entries: {
      'note:abort-anchor': {
        kind: 'note',
        slug: 'abort-anchor',
        title: 'Abort Anchor',
        tags: [],
        principles: [],
        source: [],
        createdAt: '2026-05-03',
        updatedAt: '2026-05-03',
      },
    },
    principles: {},
    entityMeta: {},
    relationships: [],
  };
}

function runtimeWithBlockingRoles(
  roles: readonly { readonly role: RetrievalRole; readonly criticality?: 'core' }[],
): KbRuntime {
  const roleRegistry = createRoleRegistry();
  for (const item of roles) {
    roleRegistry.registerBuiltin(
      item.role,
      item.criticality === undefined ? undefined : { criticality: item.criticality },
    );
  }
  const index = nonEmptyIndex();
  return {
    roleRegistry,
    readIndex: () => index,
    readIndexOrEmpty: () => index,
    readEntityGraph: () => null,
  } as unknown as KbRuntime;
}

describe('AbortSignal propagation for KB search', () => {
  it('propagates the caller signal into every in-flight retrieval role and cancels the stage', async () => {
    const controller = new AbortController();
    const seenSignals: AbortSignal[] = [];
    const abortedRoles: string[] = [];
    let started = 0;
    let resolveStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    function blockingRole(id: string, tags: readonly string[], criticality?: 'core') {
      const roleDescriptor = descriptor(id, tags, ['all']);
      const role: RetrievalRole = {
        id,
        descriptor: roleDescriptor,
        search: vi.fn(
          async (ctx) =>
            await new Promise<never>((_resolve, reject) => {
              seenSignals.push(ctx.signal);
              started += 1;
              if (started === 3) {
                resolveStarted();
              }
              const rejectAborted = () => {
                abortedRoles.push(id);
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              };
              if (ctx.signal.aborted) {
                rejectAborted();
                return;
              }
              ctx.signal.addEventListener('abort', rejectAborted, { once: true });
            }),
        ),
      };
      return { role, criticality };
    }

    const text = blockingRole('text', ['lexical'], 'core');
    const vector = blockingRole('vector', ['semantic'], 'core');
    const graph = blockingRole('graph', ['structural']);
    const searchPromise = runRetrieval(
      runtimeWithBlockingRoles([text, vector, graph]),
      createSearchRequest('abort', 5, 'all', 'hybrid', controller.signal),
    );

    await allStarted;
    controller.abort();
    const response = await searchPromise;

    expect(seenSignals).toEqual([controller.signal, controller.signal, controller.signal]);
    expect(abortedRoles).toEqual(['text', 'vector', 'graph']);
    expect(response.retrievalDiagnostics.map((diagnostic) => [diagnostic.roleId, diagnostic.code])).toEqual([
      ['text', 'role_aborted'],
      ['vector', 'role_aborted'],
      ['graph', 'role_aborted'],
    ]);
  });

  it('threads the read-side KbSearchInput signal through searchKnowledgeBase', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const textDescriptor = descriptor('text', ['lexical'], ['all']);
    const textRole: RetrievalRole = {
      id: 'text',
      descriptor: textDescriptor,
      search: vi.fn(async (ctx) => {
        seenSignal = ctx.signal;
        return { hits: [] };
      }),
    };
    const runtime = runtimeWithBlockingRoles([{ role: textRole, criticality: 'core' }]);
    const host = {
      acquireKbRuntime: vi.fn(async () => runtime),
      requireProjectRoot: vi.fn(),
    } as unknown as KbQueryHost;

    const response = await searchKnowledgeBase({ query: 'read side abort', signal: controller.signal }, host);

    expect(host.acquireKbRuntime).toHaveBeenCalledWith({ ensureBundledEngines: true });
    expect(seenSignal).toBe(controller.signal);
    expect(response.mode).toBe('text');
  });

  it('forwards the transport abort signal through the kb.entries.search dispatch case', async () => {
    const controller = new AbortController();
    const readSearch = vi.fn(async (args: Record<string, unknown>) => {
      expect(args).toMatchObject({
        query: 'abort query',
        scope: 'all',
        top_k: 3,
      });
      expect(args).not.toHaveProperty('mode');
      expect(Object.prototype.propertyIsEnumerable.call(args, 'abortSignal')).toBe(false);
      expect(args.abortSignal).toBe(controller.signal);
      return { ok: true, data: { observed: true } };
    });
    const rpcPorts = {
      kb: {
        readSearch,
      },
    } as unknown as HttpHandlerPorts;

    const response = await executeCatalogRequest(
      { name: 'kb.entries.search' } as never,
      { q: 'abort query', scope: 'all', top_k: 3 },
      rpcPorts,
      controller.signal,
    );

    expect(readSearch).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      kind: 'unary',
      body: { observed: true },
      statusCode: 200,
    });
  });
});
