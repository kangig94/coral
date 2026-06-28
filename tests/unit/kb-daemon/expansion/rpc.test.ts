import { describe, expect, it, vi } from 'vitest';

import { createExpansionRpc } from '#src/kb-daemon/expansion/rpc.js';
import type { ExpansionLifecycleService } from '#src/kb-daemon/expansion/lifecycle.js';
import { testPrincipal } from '../../../helpers/principal.js';

describe('createExpansionRpc', () => {
  it('maps lifecycle activation state onto the wire surface', async () => {
    let active = false;
    const lifecycle = {
      isActive: vi.fn(() => active),
      has: vi.fn((name: string) => name === 'needle' || name === 'failed'),
      equip: vi.fn(async () => {
        active = true;
      }),
      unequip: vi.fn(async () => {
        active = false;
      }),
      info: vi.fn((name: string) =>
        name === 'failed'
          ? {
              id: 'failed',
              version: '0.2.0',
              tier: 'installed' as const,
              status: 'installed-not-active' as const,
              lastError: 'boom',
            }
          : {
              id: name,
              version: '0.2.0',
              tier: 'installed' as const,
              status: active ? ('active' as const) : ('inactive' as const),
            },
      ),
      list: vi.fn(() => [
        {
          id: 'failed',
          version: '0.2.0',
          tier: 'installed' as const,
          status: 'installed-not-active' as const,
          lastError: 'boom',
        },
      ]),
      readBinding: vi.fn(() => ({ bound: true, heldBy: 'needle' })),
      removeExpansionCatalog: vi.fn(async () => ({ status: 'removed' as const })),
    } as unknown as ExpansionLifecycleService;

    const rpc = createExpansionRpc(lifecycle);
    const principal = testPrincipal({ transport: 'kb-daemon' });

    await expect(rpc.equipExpansion({ name: 'needle' }, principal)).resolves.toEqual({
      status: 'equipped',
      expansion: {
        name: 'needle',
        tier: 'installed',
        status: 'equipped',
      },
    });
    await expect(rpc.equipExpansion({ name: 'needle' }, principal)).resolves.toEqual({
      status: 'already_equipped',
      expansion: {
        name: 'needle',
        tier: 'installed',
        status: 'equipped',
      },
    });
    await expect(rpc.unequipExpansion({ name: 'needle' }, principal)).resolves.toEqual({ status: 'uninstalled' });
    await expect(rpc.unequipExpansion({ name: 'missing' }, principal)).resolves.toEqual({ status: 'not_equipped' });
    await expect(rpc.removeExpansionCatalog({ name: 'needle' }, principal)).resolves.toEqual({ status: 'removed' });
    await expect(rpc.listExpansion({}, principal)).resolves.toEqual({
      expansions: [{ name: 'failed', tier: 'installed', status: 'installed-not-active', lastError: 'boom' }],
    });
    await expect(rpc.readBinding({ binding: 'kb.vector' }, principal)).resolves.toEqual({
      bound: true,
      heldBy: 'needle',
    });
  });
});
