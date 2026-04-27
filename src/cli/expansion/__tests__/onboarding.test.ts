import { describe, expect, it, vi } from 'vitest';

import type { BundledExpansion } from '#src/expansion/contract.js';
import { needleOnboarding } from '../onboarding.js';

const GEMINI_ENTRY: BundledExpansion = {
  id: 'gemini',
  version: '0.5.2',
  specifier: '#src/kb/embedding/gemini/expansion.js',
  metadata: {
    description: 'Google Gemini embedding API',
    onboarding: 'required',
    slot: 'kb.embedding',
  },
};

const ONNX_ENTRY: BundledExpansion = {
  id: 'onnx',
  version: '0.5.2',
  specifier: '#src/kb/embedding/onnx/expansion.js',
  metadata: {
    description: 'Local ONNX embedding model',
    onboarding: 'required',
    slot: 'kb.embedding',
  },
};

describe('needle onboarding', () => {
  it('skips the choice prompt when kb.embedding is already bound and leaves needle equip to the outer caller', async () => {
    const events: string[] = [];
    const choose = vi.fn(async () => GEMINI_ENTRY);
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: true })),
      catalog: [GEMINI_ENTRY, ONNX_ENTRY],
      prompt: { choose },
      runOnboarding: vi.fn(async (id: string) => {
        events.push(`onboard:${id}`);
      }),
      equip: vi.fn(async (id: string) => {
        events.push(`equip:${id}`);
      }),
    };

    await needleOnboarding.run(ctx);
    await ctx.equip('needle');

    expect(choose).not.toHaveBeenCalled();
    expect(events).toEqual(['equip:needle']);
  });

  it('chooses, onboards, and equips an embedder peer before the outer caller equips needle', async () => {
    const events: string[] = [];
    const choose = vi.fn(async () => GEMINI_ENTRY);
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: false })),
      catalog: [GEMINI_ENTRY, ONNX_ENTRY],
      prompt: { choose },
      runOnboarding: vi.fn(async (id: string) => {
        events.push(`onboard:${id}`);
      }),
      equip: vi.fn(async (id: string) => {
        events.push(`equip:${id}`);
      }),
    };

    await needleOnboarding.run(ctx);
    await ctx.equip('needle');

    expect(choose).toHaveBeenCalledWith('Vector search needs an embedder:', [GEMINI_ENTRY, ONNX_ENTRY]);
    expect(events).toEqual(['onboard:gemini', 'equip:gemini', 'equip:needle']);
  });

  it('throws user-cancelled when the user backs out of the embedder choice', async () => {
    const events: string[] = [];
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: false })),
      catalog: [GEMINI_ENTRY, ONNX_ENTRY],
      prompt: {
        choose: vi.fn(async () => null),
      },
      runOnboarding: vi.fn(async (id: string) => {
        events.push(`onboard:${id}`);
      }),
      equip: vi.fn(async (id: string) => {
        events.push(`equip:${id}`);
      }),
    };

    await expect(needleOnboarding.run(ctx)).rejects.toMatchObject({
      code: 'user_cancelled',
      context: { during: 'needle-onboarding' },
    });
    expect(events).toEqual([]);
  });

  it('leaves the chosen embedder equipped if outer cancellation happens before needle equip', async () => {
    const equipped: string[] = [];
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: false })),
      catalog: [GEMINI_ENTRY, ONNX_ENTRY],
      prompt: {
        choose: vi.fn(async () => GEMINI_ENTRY),
      },
      runOnboarding: vi.fn(async () => {}),
      equip: vi.fn(async (id: string) => {
        equipped.push(id);
      }),
    };

    await needleOnboarding.run(ctx);

    expect(equipped).toEqual(['gemini']);
    expect(equipped).not.toContain('needle');
  });
});
