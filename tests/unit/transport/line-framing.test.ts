import { describe, expect, it } from 'vitest';

import { createLineFramer, FrameTooLargeError, MAX_FRAME_BYTES } from '#src/transport/line-framing.js';

describe('createLineFramer', () => {
  it('returns only complete newline-delimited frames and retains the trailing partial', () => {
    const framer = createLineFramer();

    expect(framer.push('first\nsec')).toEqual(['first']);
    expect(framer.pendingBytes()).toBe(3);
    expect(framer.flush()).toBe('sec');
    expect(framer.push(Buffer.from('ond\nthird\nfour'))).toEqual(['second', 'third']);
    expect(framer.pendingBytes()).toBe(4);
    expect(framer.flush()).toBe('four');
  });

  it('throws FrameTooLargeError when an unterminated frame exceeds MAX_FRAME_BYTES', () => {
    const framer = createLineFramer();
    const chunkSize = 1024 * 1024;
    const chunk = Buffer.alloc(chunkSize, 0x61); // 'a' bytes, no newline

    // First MAX_FRAME_BYTES / chunkSize chunks accumulate up to the cap.
    let cumulative = 0;
    for (let i = 0; i < MAX_FRAME_BYTES / chunkSize; i += 1) {
      framer.push(chunk);
      cumulative += chunkSize;
    }
    expect(cumulative).toBe(MAX_FRAME_BYTES);

    // The next byte without a newline must exceed the cap and throw.
    expect(() => framer.push('x')).toThrowError(FrameTooLargeError);
  });

  it('does not throw when oversize content is broken by a newline', () => {
    const framer = createLineFramer();
    const halfCap = MAX_FRAME_BYTES / 2;
    framer.push(Buffer.alloc(halfCap, 0x61));
    framer.push('\n');
    // After consuming the newline-terminated frame, the buffer is empty;
    // the framer should accept another half-cap without throwing.
    expect(() => framer.push(Buffer.alloc(halfCap, 0x62))).not.toThrow();
  });
});
