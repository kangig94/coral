import { describe, expect, it, vi } from 'vitest';

import type { Principal } from '#src/security/principal.js';
import { executeCatalogRequest } from '#src/transport/dispatch.js';
import { rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const operator: Principal = {
  subject: 'operator',
  transport: 'test',
  credential: { kind: 'test', id: 'operator' },
  binding: { kind: 'unbound' },
};

function wikiSpec(name: string) {
  const spec = rpcCatalog.find((candidate) => candidate.name === name);
  if (spec === undefined) throw new Error(`Missing RPC spec ${name}`);
  return spec;
}

function success(route: string) {
  return { ok: true as const, data: { route } };
}

function createPorts() {
  const kb = {
    listWikis: vi.fn(async () => success('list')),
    readWiki: vi.fn(async () => success('read')),
    createWiki: vi.fn(async () => success('create')),
    rewriteWiki: vi.fn(async () => success('rewrite')),
    linkWiki: vi.fn(async () => success('link')),
    unlinkWiki: vi.fn(async () => success('unlink')),
    citeWiki: vi.fn(async () => success('cite')),
    adoptWiki: vi.fn(async () => success('adopt')),
    deleteWiki: vi.fn(async () => success('delete')),
  };
  const ports = {
    identity: { pluginRoot: '/plugin' },
    coralEnvSnapshot: {},
    kb,
  } as unknown as HttpHandlerPorts;
  return { ports, kb };
}

describe('knowledge-base wiki RPC routing', () => {
  it.each([
    ['kb.wiki.list', 'listWikis', {}, 'list', 200],
    ['kb.wiki.read', 'readWiki', { slug: 'living-knowledge' }, 'read', 200],
    ['kb.wiki.create', 'createWiki', { slug: 'living-knowledge' }, 'create', 201],
    ['kb.wiki.rewrite', 'rewriteWiki', { slug: 'living-knowledge', understanding: 'updated' }, 'rewrite', 200],
    ['kb.wiki.link', 'linkWiki', { slug: 'living-knowledge', refs: ['note:alpha'] }, 'link', 200],
    ['kb.wiki.unlink', 'unlinkWiki', { slug: 'living-knowledge', refs: ['note:alpha'] }, 'unlink', 200],
    [
      'kb.wiki.cite',
      'citeWiki',
      { slug: 'living-knowledge', ref: 'note:alpha', evidenceFile: '/tmp/evidence.md' },
      'cite',
      200,
    ],
    ['kb.wiki.adopt', 'adoptWiki', { slug: 'living-knowledge', title: 'Living Knowledge' }, 'adopt', 201],
    ['kb.wiki.delete', 'deleteWiki', { slug: 'living-knowledge' }, 'delete', 200],
  ] as const)('routes %s to %s', async (route, method, body, expectedRoute, statusCode) => {
    const { ports, kb } = createPorts();
    const request =
      route === 'kb.wiki.list' || route === 'kb.wiki.read' ? body : { ...body, projectRoot: process.cwd() };

    const result = await executeCatalogRequest(wikiSpec(route), request, ports, operator);

    expect(result).toMatchObject({ kind: 'unary', statusCode, body: { route: expectedRoute } });
    expect(kb[method]).toHaveBeenCalledOnce();
  });
});
