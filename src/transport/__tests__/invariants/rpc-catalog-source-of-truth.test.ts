import { describe, expect, it } from 'vitest';
import { rpcCatalog, transportOperationalCarveouts } from '../../rpc-catalog.js';
import {
  buildCoordinatorHttpDispatchTable,
  coordinatorHttpRoutes,
  httpAdapter,
  transportLocalRoutes,
} from '../../http/handler.js';
import type { HttpHandlerPorts } from '../../http/contracts.js';
import { buildCoordinatorIpcDispatchTable, ipcAdapter } from '../../ipc/server.js';

describe('rpc catalog source of truth', () => {
  it('keeps coordinator RPC specs handler-free', () => {
    for (const spec of rpcCatalog as ReadonlyArray<Record<string, unknown>>) {
      expect(spec).not.toHaveProperty('handler');
    }
  });

  it('keeps the fixed transport-local operational carveout list explicit', () => {
    expect(transportOperationalCarveouts).toEqual(['/health', '/admin/shutdown', '/events/stream']);
  });

  it('projects the coordinator HTTP dispatch table via rpcCatalog.map(spec => httpAdapter(spec, rpcPorts))', () => {
    const rpcPorts = {} as HttpHandlerPorts;
    const projected = buildCoordinatorHttpDispatchTable(rpcPorts).map(({ method, path, pattern, spec }) => ({
      method,
      path,
      pattern: pattern.source,
      spec,
    }));
    const mapped = rpcCatalog.map((spec) => httpAdapter(spec, rpcPorts)).map(({ method, path, pattern, spec }) => ({
      method,
      path,
      pattern: pattern.source,
      spec,
    }));

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
    const mapped = rpcCatalog.map((spec) => ipcAdapter(spec, rpcPorts)).map(({ method, spec }) => ({
      method,
      spec,
    }));

    expect(projected).toEqual(mapped);
  });

  it('rejects coordinator RPC HTTP routes outside rpcCatalog unless they appear in the fixed operational carveout list', () => {
    const rpcPorts = {} as HttpHandlerPorts;
    const coordinatorRouteKeys = buildCoordinatorHttpDispatchTable(rpcPorts).map(({ method, path }) => `${method} ${path}`);
    const catalogKeys = rpcCatalog.map((spec) => `${spec.http.method} ${spec.http.path}`);

    expect(coordinatorRouteKeys).toEqual(catalogKeys);
    expect(transportLocalRoutes).toEqual([
      { method: 'GET', path: '/health' },
      { method: 'POST', path: '/admin/shutdown' },
      { method: 'GET', path: '/events/stream' },
    ]);
    expect(transportLocalRoutes.map((route) => route.path)).toEqual([...transportOperationalCarveouts]);
  });
});
