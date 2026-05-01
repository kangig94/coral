import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(ROOT, 'src');

describe('provider terminal causality invariant', () => {
  it('keeps provider terminal failures as canonical cause descriptors, not embedded fault payloads', () => {
    const violations: string[] = [];

    for (const filePath of listProductionSourceFiles(SRC_ROOT)) {
      const canonical = relative(ROOT, filePath).split('\\').join('/');
      const content = readFileSync(filePath, 'utf-8');
      if (/\|\s*\{\s*kind:\s*['"]failed['"];\s*fault:/.test(content)) {
        violations.push(`${canonical}: TerminalOutcome failed variant embeds fault payload`);
      }
      if (/faultPayloadSchema|type\s+FaultPayload\b/.test(content)) {
        violations.push(`${canonical}: provider-local fault payload schema/type remains`);
      }
    }

    expect(violations).toEqual([]);
  });
});
