import { describe, expect, it, vi } from 'vitest';

import { runExpansionOnboarding } from '#src/cli/expansion/onboarding.js';
import { BUNDLED_ENGINES } from '#src/expansion/bundled.js';

const GEMINI_ENTRY = BUNDLED_ENGINES.find((entry) => entry.id === 'gemini');
const ONNX_ENTRY = BUNDLED_ENGINES.find((entry) => entry.id === 'onnx');

if (!GEMINI_ENTRY || !ONNX_ENTRY) {
  throw new Error('test requires gemini and onnx bundled engine entries');
}

describe('expansion onboarding', () => {
  it('skips the choice prompt when kb.embedding is already bound and leaves needle equip to the outer caller', async () => {
    const events: string[] = [];
    const choose = vi.fn(async () => GEMINI_ENTRY);
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: true })),
      prompt: { choose },
      runOnboarding: vi.fn(async (id: string) => {
        events.push(`onboard:${id}`);
      }),
      equip: vi.fn(async (id: string) => {
        events.push(`equip:${id}`);
      }),
    };

    await runExpansionOnboarding('needle', ctx);
    await ctx.equip('needle');

    expect(choose).not.toHaveBeenCalled();
    expect(events).toEqual(['equip:needle']);
  });

  it('chooses, onboards, and equips an embedder peer before the outer caller equips needle', async () => {
    const events: string[] = [];
    const choose = vi.fn(async () => GEMINI_ENTRY);
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: false })),
      prompt: { choose },
      runOnboarding: vi.fn(async (id: string) => {
        events.push(`onboard:${id}`);
      }),
      equip: vi.fn(async (id: string) => {
        events.push(`equip:${id}`);
      }),
    };

    await runExpansionOnboarding('needle', ctx);
    await ctx.equip('needle');

    expect(choose).toHaveBeenCalledWith("Expansion 'needle' needs 'kb.embedding':", [GEMINI_ENTRY, ONNX_ENTRY]);
    expect(events).toEqual(['onboard:gemini', 'equip:gemini', 'equip:needle']);
  });

  it('throws user-cancelled when the user backs out of the embedder choice', async () => {
    const events: string[] = [];
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: false })),
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

    await expect(runExpansionOnboarding('needle', ctx)).rejects.toMatchObject({
      code: 'user_cancelled',
      context: { during: 'needle-onboarding' },
    });
    expect(events).toEqual([]);
  });

  it('throws binding_required with candidates instead of prompting in non-interactive contexts', async () => {
    const choose = vi.fn(async () => GEMINI_ENTRY);
    const ctx = {
      interactive: false,
      readBinding: vi.fn(async () => ({ bound: false })),
      prompt: { choose },
      runOnboarding: vi.fn(async () => {}),
      equip: vi.fn(async () => {}),
    };

    await expect(runExpansionOnboarding('needle', ctx)).rejects.toMatchObject({
      code: 'binding_required',
      context: {
        binding: 'kb.embedding',
        requiredBy: 'needle',
        candidates: ['gemini', 'onnx'],
      },
    });
    expect(choose).not.toHaveBeenCalled();
  });

  it('throws engine_env_var_missing when a declared env-var step is unset', async () => {
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: false })),
      env: { get: vi.fn(() => undefined) },
      prompt: { choose: vi.fn(async () => null) },
      runOnboarding: vi.fn(async () => {}),
      equip: vi.fn(async () => {}),
    };

    await expect(runExpansionOnboarding('gemini', ctx)).rejects.toMatchObject({
      code: 'engine_env_var_missing',
      context: { engine: 'gemini', envVar: 'GEMINI_API_KEY' },
    });
  });

  it('leaves the chosen embedder equipped if outer cancellation happens before needle equip', async () => {
    const equipped: string[] = [];
    const ctx = {
      readBinding: vi.fn(async () => ({ bound: false })),
      prompt: {
        choose: vi.fn(async () => GEMINI_ENTRY),
      },
      runOnboarding: vi.fn(async () => {}),
      equip: vi.fn(async (id: string) => {
        equipped.push(id);
      }),
    };

    await runExpansionOnboarding('needle', ctx);

    expect(equipped).toEqual(['gemini']);
    expect(equipped).not.toContain('needle');
  });
});
