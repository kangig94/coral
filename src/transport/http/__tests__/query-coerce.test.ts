import { describe, expect, it } from 'vitest';
import {
  discussDeleteQuerySchema,
  discussDetailQuerySchema,
  discussEventsQuerySchema,
} from '../../../discuss/api.js';
import {
  kbMemoDeleteQuerySchema,
  kbMemoListQuerySchema,
  kbPrinciplesQuerySchema,
  kbSearchQuerySchema,
} from '../../../kb/api.js';
import {
  buildCallerContextFromQuery,
  parseBooleanQuery,
  queryParamsToObject,
} from '../query-coerce.js';

describe('query-coerce transport helpers', () => {
  it('parses boolean query values safely', () => {
    expect(parseBooleanQuery('true')).toBe(true);
    expect(parseBooleanQuery('1')).toBe(true);
    expect(parseBooleanQuery('false')).toBe(false);
    expect(parseBooleanQuery('0')).toBe(false);
    expect(parseBooleanQuery(undefined)).toBeUndefined();
    expect(parseBooleanQuery('')).toBeUndefined();
    expect(parseBooleanQuery('wat')).toBeUndefined();
  });

  it('converts URLSearchParams into a plain object', () => {
    const params = new URLSearchParams('q=first&q=second&owner=kang');

    expect(queryParamsToObject(params)).toEqual({
      q: 'second',
      owner: 'kang',
    });
  });

  it('coerces typed GET query params with route-specific schemas', () => {
    expect(
      kbSearchQuerySchema.parse({
        q: 'retrieval',
        scope: 'all',
        top_k: '5',
        mode: 'vector',
      }),
    ).toEqual({
      q: 'retrieval',
      scope: 'all',
      top_k: 5,
      mode: 'vector',
    });

    expect(
      kbPrinciplesQuerySchema.parse({
        q: 'latency',
        top_k: '3',
        verbose: '0',
      }),
    ).toEqual({
      q: 'latency',
      top_k: 3,
      verbose: false,
    });

    expect(
      discussEventsQuerySchema.parse({
        cursor: '9',
        projectRoot: '/repo/project',
      }),
    ).toEqual({
      cursor: 9,
      projectRoot: '/repo/project',
    });

    expect(
      kbMemoListQuerySchema.parse({
        projectRoot: '/repo/project',
        owner: 'kang',
      }),
    ).toEqual({
      projectRoot: '/repo/project',
      owner: 'kang',
    });

    expect(
      discussDetailQuerySchema.parse({
        projectRoot: '/repo/project',
        view: 'audit',
      }),
    ).toEqual({
      projectRoot: '/repo/project',
      view: 'audit',
    });

    expect(
      discussDeleteQuerySchema.parse({
        projectRoot: '/repo/project',
      }),
    ).toEqual({
      projectRoot: '/repo/project',
    });
  });

  it('rejects invalid boolean query values after preprocessing', () => {
    const parsed = kbPrinciplesQuerySchema.safeParse({ verbose: 'wat' });

    expect(parsed.success).toBe(false);
  });

  it('enforces exactly one memo delete mode in the transport schema', () => {
    expect(
      kbMemoDeleteQuerySchema.parse({
        projectRoot: '/repo/project',
        pattern: '2026-',
      }),
    ).toEqual({
      projectRoot: '/repo/project',
      pattern: '2026-',
    });

    expect(
      kbMemoDeleteQuerySchema.parse({
        projectRoot: '/repo/project',
        all: '1',
      }),
    ).toEqual({
      projectRoot: '/repo/project',
      all: true,
    });

    const missingMode = kbMemoDeleteQuerySchema.safeParse({
      projectRoot: '/repo/project',
    });
    expect(missingMode.success).toBe(false);
    if (!missingMode.success) {
      expect(missingMode.error.issues[0]?.message).toBe('Exactly one of pattern or all=true must be provided');
    }

    const conflictingModes = kbMemoDeleteQuerySchema.safeParse({
      projectRoot: '/repo/project',
      pattern: '2026-',
      all: 'true',
    });
    expect(conflictingModes.success).toBe(false);
    if (!conflictingModes.success) {
      expect(conflictingModes.error.issues[0]?.message).toBe('Exactly one of pattern or all=true must be provided');
    }
  });

  it('rebuilds CallerContext from query params using the injected CORAL env snapshot only', () => {
    const context = buildCallerContextFromQuery('/repo/project', '/plugin/root', {
      CORAL_OWNER: 'transport-owner',
      CORAL_EFFORT: 'high',
    });

    expect(context.projectRoot).toBe('/repo/project');
    expect(context.pluginRoot).toBe('/plugin/root');
    expect(context.coralEnv).toEqual(
      expect.objectContaining({
        CORAL_OWNER: 'transport-owner',
        CORAL_EFFORT: 'high',
      }),
    );
    expect(context.coralEnv.NOT_CORAL).toBeUndefined();
  });
});
