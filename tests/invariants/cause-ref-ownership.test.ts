import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('CauseRef ownership', () => {
  it('keeps CauseRef exported only from the causality module', () => {
    const causalitySource = readFileSync(join(REPO_ROOT, 'src/causality/cause-ref.ts'), 'utf8');
    const jobOutcomeSource = readFileSync(join(REPO_ROOT, 'src/jobs/outcome.ts'), 'utf8');

    expect(causalitySource).toMatch(/\bexport interface CauseRef\b/);
    expect(causalitySource).toMatch(/\bexport const causeRefSchema\b/);
    expect(jobOutcomeSource).not.toMatch(/\bexport\s+\{[^}]*\bCauseRef\b/);
    expect(jobOutcomeSource).not.toMatch(/\bexport\s+\{[^}]*\bcauseRefSchema\b/);
  });
});
