import { describe, expect, it } from 'vitest';
import { rpcCatalog, transportOperationalCarveouts } from '../../rpc-catalog.js';

describe('rpc catalog source of truth', () => {
  it('keeps coordinator RPC specs handler-free', () => {
    for (const spec of rpcCatalog as ReadonlyArray<Record<string, unknown>>) {
      expect(spec).not.toHaveProperty('handler');
    }
  });

  it('keeps the fixed transport-local operational carveout list explicit', () => {
    expect(transportOperationalCarveouts).toEqual(['/health', '/admin/shutdown', '/events/stream']);
  });

  it.todo('projects the coordinator HTTP dispatch table via rpcCatalog.map(spec => httpAdapter(spec, rpcPorts))');

  it.todo('projects the IPC dispatch table via rpcCatalog.map(spec => ipcAdapter(spec, rpcPorts))');

  it.todo('rejects coordinator RPC HTTP routes outside rpcCatalog unless they appear in the fixed operational carveout list');
});
