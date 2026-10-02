import { describe, expect, it } from 'vitest';

import { parseDeclaredKbAnalyzers } from '#src/kb/extra-langs.js';

describe('KB declared analyzer config', () => {
  it('ignores unknown analyzer codes', () => {
    expect(parseDeclaredKbAnalyzers('ko,zz')).toEqual(['ko']);
  });
});
