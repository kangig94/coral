import { describe, expect, it, vi } from 'vitest';

import { createExpansionRpc } from '#src/coordinator/expansion/rpc.js';
import type { ExpansionLifecycleService } from '#src/coordinator/expansion/lifecycle.js';

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
          ? { id: 'failed', version: '0.2.0', status: 'installed-not-active' as const, lastError: 'boom' }
          : { id: name, version: '0.2.0', status: (active ? 'active' : 'inactive') as const },
      ),
      list: vi.fn(() => [{ id: 'failed', version: '0.2.0', status: 'installed-not-active' as const, lastError: 'boom' }]),
      readBinding: vi.fn(() => ({ bound: true, heldBy: 'needle' })),
    } as unknown as ExpansionLifecycleService;

    const rpc = createExpansionRpc(lifecycle);

    await expect(rpc.equipExpansion({ name: 'needle' })).resolves.toEqual({
      status: 'equipped',
      expansion: {
        name: 'needle',
        status: 'equipped',
      },
    });
    await expect(rpc.equipExpansion({ name: 'needle' })).resolves.toEqual({
      status: 'already_equipped',
      expansion: {
        name: 'needle',
        status: 'equipped',
      },
    });
    await expect(rpc.unequipExpansion({ name: 'needle' })).resolves.toEqual({ status: 'uninstalled' });
    await expect(rpc.unequipExpansion({ name: 'missing' })).resolves.toEqual({ status: 'not_equipped' });
    await expect(rpc.listExpansion({})).resolves.toEqual({
      expansions: [{ name: 'failed', status: 'installed-not-active', lastError: 'boom' }],
    });
    await expect(rpc.readBinding({ binding: 'kb.vector' })).resolves.toEqual({ bound: true, heldBy: 'needle' });
  });
});
