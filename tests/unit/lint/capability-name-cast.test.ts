import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

describe('KbCapabilityName lint guard', () => {
  it('rejects direct KbCapabilityName casts outside parser boundaries', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const fixturePath = join(process.cwd(), 'tests/unit/lint/capability-name-cast-probe.generated.ts');
    writeFileSync(
      fixturePath,
      [
        "import type { KbCapabilityName } from '#src/kb/capability/contract.js';",
        "const raw = 'vendor.cache';",
        `const name = raw as ${'KbCapabilityName'};`,
        'void name;',
      ].join('\n'),
      'utf8',
    );

    try {
      const [result] = await eslint.lintFiles([fixturePath]);

      expect(result?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'no-restricted-syntax',
          }),
        ]),
      );
    } finally {
      rmSync(fixturePath, { force: true });
    }
  });
});
