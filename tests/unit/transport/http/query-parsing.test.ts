import { describe, expect, it } from 'vitest';
import { fixtureCanonicalWorkDir } from '#tests/helpers/canonical-work-dir.js';
import {
  KB_SEARCH_QUERY_MAX_CODE_POINTS,
  KB_SLUG_MAX_BYTES,
  KB_TEXT_FILTER_MAX_CODE_POINTS,
  kbMemoDeleteQuerySchema,
  kbMemoListQuerySchema,
  kbNoteReadRequestSchema,
  kbPrinciplesQuerySchema,
  kbSearchSchema,
  kbSearchQuerySchema,
} from '#src/kb/tool-contracts.js';
import { buildInvocationContextFromQuery } from '#src/transport/invocation-context.js';
import { testProjectPrincipal } from '#tests/helpers/principal.js';

describe('transport HTTP query parsing', () => {
  it('rejects oversized KB search queries and text filters before route handlers run', () => {
    const oversizedSearchQuery = 'q'.repeat(KB_SEARCH_QUERY_MAX_CODE_POINTS + 1);
    const oversizedFilter = 'f'.repeat(KB_TEXT_FILTER_MAX_CODE_POINTS + 1);
    const oversizedSlug = 's'.repeat(KB_SLUG_MAX_BYTES + 1);

    expect(kbSearchSchema.safeParse({ query: oversizedSearchQuery }).success).toBe(false);
    expect(kbSearchQuerySchema.safeParse({ q: oversizedSearchQuery }).success).toBe(false);
    expect(kbPrinciplesQuerySchema.safeParse({ q: oversizedSearchQuery }).success).toBe(false);
    expect(kbMemoListQuerySchema.safeParse({ projectRoot: '/repo/project', owner: oversizedFilter }).success).toBe(
      false,
    );
    expect(kbMemoDeleteQuerySchema.safeParse({ projectRoot: '/repo/project', pattern: oversizedFilter }).success).toBe(
      false,
    );
    expect(kbNoteReadRequestSchema.safeParse({ slug: oversizedSlug }).success).toBe(false);
  });

  it('rebuilds InvocationContext from query params using the injected CORAL env snapshot only', () => {
    const principal = testProjectPrincipal('/repo/project');
    const context = buildInvocationContextFromQuery(
      fixtureCanonicalWorkDir('/repo/project'),
      '/plugin/root',
      {
        CORAL_OWNER: 'transport-owner',
        CORAL_EFFORT: 'high',
      },
      principal,
    );

    expect(context.projectRoot).toBe('/repo/project');
    expect(context.pluginRoot).toBe('/plugin/root');
    expect(context.principal).toBe(principal);
    expect(context.coralEnv).toEqual(
      expect.objectContaining({
        CORAL_OWNER: 'transport-owner',
        CORAL_EFFORT: 'high',
      }),
    );
    expect(context.coralEnv.NOT_CORAL).toBeUndefined();
  });
});
