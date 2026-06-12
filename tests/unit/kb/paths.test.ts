import { describe, expect, it } from 'vitest';
import { notePathFromName } from '#src/kb/paths.js';

function slugWithControl(codePoint: number): string {
  return `bad${String.fromCharCode(codePoint)}slug`;
}

describe('KB paths', () => {
  it.each([0x00, 0x1f, 0x7f, 0x9f])('rejects control character U+%s in slugs', (codePoint) => {
    expect(() => notePathFromName(slugWithControl(codePoint), '/tmp/coral-kb')).toThrow(
      'KB note path cannot contain control characters',
    );
  });
});
