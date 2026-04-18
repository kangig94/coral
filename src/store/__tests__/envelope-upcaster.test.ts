import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { CoralSetupError } from '../../runtime/errors.js';
import { createEmptyRegistry } from '../envelope.js';

describe('UpcasterRegistry', () => {
  it('registerUpcaster records the type/fromVersion pair with its target version and function', () => {
    const registry = createEmptyRegistry();
    const fn = (body: unknown) => body;

    registry.registerUpcaster('test.recorded', 1, 2, fn);

    expect((registry as unknown as { entries: Map<string, { toVersion: number; fn: (body: unknown) => unknown }> }).entries.get('test.recorded|1')).toEqual({
      toVersion: 2,
      fn,
    });
  });

  it('throws CoralSetupError(upcaster_conflict) for duplicate type/fromVersion registrations', () => {
    const registry = createEmptyRegistry();
    const fn = (body: unknown) => body;
    registry.registerUpcaster('test.recorded', 1, 2, fn);

    let thrown: unknown;
    try {
      registry.registerUpcaster('test.recorded', 1, 3, fn);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).code).toBe('upcaster_conflict');
    expect((thrown as CoralSetupError).userMessage).toContain("type 'test.recorded' from v1");
  });

  it('parseBody applies a single v1 -> v2 upcaster', () => {
    const registry = createEmptyRegistry();
    registry.registerUpcaster('test.upcasted', 1, 2, (body) => ({ count: (body as { n: number }).n }));

    const parsed = registry.parseBody(
      'test.upcasted',
      1,
      { n: 7 },
      z
        .object({
          count: z.number(),
        })
        .strict(),
    );

    expect(parsed).toEqual({ count: 7 });
  });

  it('parseBody applies a v1 -> v2 -> v3 chain', () => {
    const registry = createEmptyRegistry();
    registry.registerUpcaster('test.upcasted', 1, 2, (body) => ({ count: (body as { n: number }).n }));
    registry.registerUpcaster('test.upcasted', 2, 3, (body) => ({
      count: (body as { count: number }).count,
      label: 'v3',
    }));

    const parsed = registry.parseBody(
      'test.upcasted',
      1,
      { n: 7 },
      z
        .object({
          count: z.number(),
          label: z.literal('v3'),
        })
        .strict(),
    );

    expect(parsed).toEqual({ count: 7, label: 'v3' });
  });

  it('parseBody validates against currentSchema and returns the parsed result', () => {
    const registry = createEmptyRegistry();
    const parsed = registry.parseBody(
      'test.current',
      2,
      { count: '7' },
      z
        .object({
          count: z.coerce.number(),
        })
        .strict(),
    );

    expect(parsed).toEqual({ count: 7 });
  });

  it('throws CoralSetupError(upcaster_missing) when the upcaster chain is incomplete', () => {
    const registry = createEmptyRegistry();
    registry.registerUpcaster('test.upcasted', 1, 2, (body) => ({ count: (body as { n: number }).n }));

    let thrown: unknown;
    try {
      registry.parseBody(
        'test.upcasted',
        3,
        { count: 7 },
        z
          .object({
            total: z.number(),
          })
          .strict(),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).code).toBe('upcaster_missing');
    expect((thrown as CoralSetupError).context).toMatchObject({
      type: 'test.upcasted',
      bodyVersion: 3,
      stoppedAt: 3,
    });
  });

  it('validates directly against the current schema when bodyVersion is already current', () => {
    const registry = createEmptyRegistry();
    const parsed = registry.parseBody(
      'test.current',
      2,
      { count: 7 },
      z
        .object({
          count: z.number(),
        })
        .strict(),
    );

    expect(parsed).toEqual({ count: 7 });
  });
});
