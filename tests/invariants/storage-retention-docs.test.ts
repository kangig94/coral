import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('storage retention documentation', () => {
  it('documents one retention knob, provider originals, journal progress and startup plus daily cadence', () => {
    const configuration = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf-8');
    const row = configuration.split('\n').find((line) => line.startsWith('| `CORAL_JOBS_RETENTION_DAYS`'))!;
    for (const text of ['14', 'provider-artifacts/', 'journal progress', 'startup', '24 h', 'Live or unknown'])
      expect(row).toContain(text);
    expect(configuration).not.toContain('never opened, locked, or deleted by this build');
  });

  it('records the settled lifetime and leaves provider-session restore open', () => {
    const todo = readFileSync(new URL('../../docs/todo/export-lifetime.md', import.meta.url), 'utf-8');
    expect(todo).toContain('retention decided; restore design remains open');
    expect(todo).toContain('Expired exports');
    expect(todo).toContain('collision rule');
  });

  it('records domain owners and coordinator scheduling in both architecture guides', () => {
    for (const path of ['architecture', 'core-modules']) {
      const document = readFileSync(new URL(`../../docs/${path}.md`, import.meta.url), 'utf-8');
      for (const owner of [
        'jobs/export-retention.ts',
        'jobs/progress-retention.ts',
        'store/epoch/legacy-retention.ts',
        'store/retention-vacuum.ts',
        'coordinator/composition/storage-retention-scheduler.ts',
      ])
        expect(document).toContain(owner);
      expect(document).not.toContain('this build never deletes');
    }
  });
});
