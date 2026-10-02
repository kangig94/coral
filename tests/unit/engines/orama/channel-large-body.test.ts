import { describe, expect, it } from 'vitest';

import { buildOramaSearchChannelFields } from '#src/engines/orama/search-channels.js';

describe('orama search-channels large-body regression', () => {
  // Regression (#239): building the n-gram channel over a long body used to
  // spread a ~160k-element array into Array.push (`terms.push(...characterNgrams(...))`),
  // overflowing V8's call argument limit and throwing
  // "RangeError: Maximum call stack size exceeded" during KB index build —
  // surfacing as an apparent infinite recursion. ~80k Hangul chars yields
  // ~160k 2/3-grams, comfortably past the ~125k limit.
  const longHangulBody = '가나다라마바사아자차'.repeat(8_000);

  it('builds channel fields for a very long Hangul body without overflowing the stack', () => {
    let fields: ReturnType<typeof buildOramaSearchChannelFields> | undefined;
    expect(() => {
      fields = buildOramaSearchChannelFields({
        slug: 'large-community',
        title: '대규모 커뮤니티 요약',
        body: longHangulBody,
        tags: [],
        principles: [],
      });
    }).not.toThrow();
    expect(fields?.bodyNgram.length ?? 0).toBeGreaterThan(0);
    expect(fields?.bodySurface.length ?? 0).toBeGreaterThan(0);
  });
});
