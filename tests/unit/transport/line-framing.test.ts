import { describe, expect, it } from 'vitest';

import { createLineFramer } from '#src/transport/line-framing.js';

describe('createLineFramer', () => {
  it('returns only complete newline-delimited frames and retains the trailing partial', () => {
    const framer = createLineFramer();

    expect(framer.push('first\nsec')).toEqual(['first']);
    expect(framer.flush()).toBe('sec');
    expect(framer.push(Buffer.from('ond\nthird\nfour'))).toEqual(['second', 'third']);
    expect(framer.flush()).toBe('four');
  });
});
