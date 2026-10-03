import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('storage retention documentation', () => {
  it('documents one retention knob, provider originals, journal progress and startup plus daily cadence', () => {
    const configuration = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf-8');
    const row = configuration.split('\n').find((line) => line.startsWith('| `CORAL_JOBS_RETENTION_DAYS`'))!;
    for (const text of ['14', 'provider-artifacts/', 'journal progress', 'startup', '24 h', 'Live or unknown'])
      expect(row).toContain(text);
  });

  it('records the settled lifetime and leaves provider-session restore open', () => {
    const todo = readFileSync(new URL('../../docs/todo/export-lifetime.md', import.meta.url), 'utf-8');
    expect(todo).toContain('retention decided; restore design remains open');
    expect(todo).toContain('Expired exports');
    expect(todo).toContain('collision rule');
    expect(todo).toContain('top-level entries, including directories');
    expect(todo).toContain('deletion admission persists the cutoff in meta');
  });

  it('has no unused exclusive connection option or fixed owner count after legacy removal', () => {
    const lock = readFileSync(new URL('../../src/infra/fs-lock.ts', import.meta.url), 'utf-8');
    expect(lock).not.toContain('exclusiveConnection');
    const architecture = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf-8');
    expect(architecture).not.toMatch(/Each of the \w+ owners/);
    expect(architecture).toContain('Each owner receives its own 5-second cooperative budget');
  });

  it('records domain owners and coordinator scheduling in both architecture guides', () => {
    for (const path of ['architecture', 'core-modules']) {
      const document = readFileSync(new URL(`../../docs/${path}.md`, import.meta.url), 'utf-8');
      for (const owner of [
        'jobs/export-retention.ts',
        'jobs/progress-retention.ts',
        'jobs/location-index.ts',
        'store/custody-ledger.ts',
        'coordinator/services/recovery/custody-reconciliation.ts',
        'store/retention-vacuum.ts',
        'coordinator/composition/storage-retention-scheduler.ts',
      ])
        expect(document).toContain(owner);
      expect(document).not.toContain('store/epoch/legacy-retention.ts');
      expect(document).toContain('one-time residue because pre-epoch writers cannot be excluded');
    }
  });

  it('describes legacy preservation without promising SQLite writer exclusion', () => {
    const architecture = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf-8');
    expect(architecture).not.toContain('absent legacy holders under an exclusive SQLite lock');
    expect(architecture).not.toContain('R1 depends on the filesystem updating mtime on writes');
  });
});

it('documents the expanded single knob and bounded backlog drain', () => {
  const configuration = readFileSync(new URL('../../docs/configuration.md', import.meta.url), 'utf8');
  const row = configuration.split('\n').find((line) => line.startsWith('| `CORAL_JOBS_RETENTION_DAYS`'))!;
  for (const text of ['terminal scratch', 'discharged custody', 'absence proof', '5 minutes', 'compact automatically'])
    expect(row).toContain(text);
  for (const text of ['deletedByOwner', 'root identity', 'writer fencing']) expect(configuration).toContain(text);
});
