import { describe, expect, it } from 'vitest';
import { KB_DAEMON_KB_MUTATION_METHODS, KB_DAEMON_KB_READ_METHODS } from '#src/kb-daemon/protocol.js';
import { rpcCatalog, transportOperationalCarveouts } from '#src/transport/rpc/catalog.js';
import {
  buildCoordinatorHttpDispatchTable,
  coordinatorHttpRoutes,
  httpAdapter,
  transportLocalRoutes,
} from '#src/transport/http/handler.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { buildCoordinatorIpcDispatchTable, ipcAdapter } from '#src/transport/ipc/server.js';

describe('rpc catalog source of truth', () => {
  it('keeps coordinator RPC specs handler-free', () => {
    for (const spec of rpcCatalog as ReadonlyArray<Record<string, unknown>>) {
      expect(spec).not.toHaveProperty('handler');
    }
  });

  it('keeps the fixed transport-local operational carveout list explicit', () => {
    expect(transportOperationalCarveouts).toEqual([
      '/health',
      '/admin/shutdown',
      '/admin/kb/restart',
      '/events/stream',
    ]);
  });

  it('projects the coordinator HTTP dispatch table via rpcCatalog.map(spec => httpAdapter(spec, rpcPorts))', () => {
    const rpcPorts = {} as HttpHandlerPorts;
    const table = buildCoordinatorHttpDispatchTable(rpcPorts);
    const projected = [...table.static.values(), ...table.params]
      .map(({ method, path, pattern, spec }) => ({ method, path, pattern: pattern.source, spec }))
      .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
    const mapped = rpcCatalog
      .map((spec) => httpAdapter(spec, rpcPorts))
      .map(({ method, path, pattern, spec }) => ({ method, path, pattern: pattern.source, spec }))
      .sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));

    expect(projected).toEqual(mapped);
    expect(coordinatorHttpRoutes).toEqual(
      rpcCatalog.map((spec) => ({
        method: spec.http.method,
        path: spec.http.path,
        spec,
      })),
    );
  });

  it('projects the IPC dispatch table via rpcCatalog.map(spec => ipcAdapter(spec, rpcPorts))', () => {
    const rpcPorts = {} as HttpHandlerPorts;
    const projected = buildCoordinatorIpcDispatchTable(rpcPorts).map(({ method, spec }) => ({
      method,
      spec,
    }));
    const mapped = rpcCatalog
      .map((spec) => ipcAdapter(spec, rpcPorts))
      .map(({ method, spec }) => ({
        method,
        spec,
      }));

    expect(projected).toEqual(mapped);
  });

  it('rejects coordinator RPC HTTP routes outside rpcCatalog unless they appear in the fixed operational carveout list', () => {
    const rpcPorts = {} as HttpHandlerPorts;
    const table = buildCoordinatorHttpDispatchTable(rpcPorts);
    const coordinatorRouteKeys = [...table.static.values(), ...table.params]
      .map(({ method, path }) => `${method} ${path}`)
      .sort();
    const catalogKeys = rpcCatalog.map((spec) => `${spec.http.method} ${spec.http.path}`).sort();

    expect(coordinatorRouteKeys).toEqual(catalogKeys);
    expect(transportLocalRoutes).toEqual([
      { method: 'GET', path: '/health' },
      { method: 'POST', path: '/admin/shutdown' },
      { method: 'POST', path: '/admin/kb/restart' },
      { method: 'GET', path: '/events/stream' },
    ]);
    expect(transportLocalRoutes.map((route) => route.path)).toEqual([...transportOperationalCarveouts]);
  });

  it('keeps KB daemon read protocol methods aligned with read-only KB RPC catalog entries', () => {
    const kbDaemonReadRpcByMethod = {
      readSearch: 'kb.entries.search',
      diagnose: 'kb.diagnose',
      readNote: 'kb.note.read',
      readSource: 'kb.source.read',
      readCommunity: 'kb.community.read',
      listStaleCommunities: 'kb.community.list-stale',
      readCommunitySummaryInput: 'kb.community.summary-input',
      readWiki: 'kb.wiki.read',
      readMemo: 'kb.memo.read',
      readPrinciple: 'kb.principle.read',
      listSources: 'kb.source.list',
      listWikis: 'kb.wiki.list',
      listMemos: 'kb.memo.list',
      listPrinciples: 'kb.principles.list',
      wakeUp: 'kb.wake_up',
    } as const;
    const catalogNames = new Set(rpcCatalog.map((spec) => spec.name));

    expect([...KB_DAEMON_KB_READ_METHODS].sort()).toEqual(Object.keys(kbDaemonReadRpcByMethod).sort());
    expect(Object.values(kbDaemonReadRpcByMethod).every((name) => catalogNames.has(name))).toBe(true);
  });

  it('keeps KB daemon mutation protocol methods aligned with KB RPC catalog entries', () => {
    const kbDaemonMutationRpcByMethod = {
      setCommunitySummary: 'kb.community.set-summary',
      createNote: 'kb.note.create',
      updateNote: 'kb.note.update',
      deleteNote: 'kb.note.delete',
      createSource: 'kb.source.create',
      createWiki: 'kb.wiki.create',
      rewriteWiki: 'kb.wiki.rewrite',
      linkWiki: 'kb.wiki.link',
      unlinkWiki: 'kb.wiki.unlink',
      citeWiki: 'kb.wiki.cite',
      adoptWiki: 'kb.wiki.adopt',
      deleteWiki: 'kb.wiki.delete',
      deleteSource: 'kb.source.delete',
      createMemo: 'kb.memo.create',
      deleteMemos: 'kb.memo.delete',
      reindex: 'kb.reindex',
    } as const;
    const catalogNames = new Set(rpcCatalog.map((spec) => spec.name));

    expect([...KB_DAEMON_KB_MUTATION_METHODS].sort()).toEqual(Object.keys(kbDaemonMutationRpcByMethod).sort());
    expect(Object.values(kbDaemonMutationRpcByMethod).every((name) => catalogNames.has(name))).toBe(true);
  });
});
