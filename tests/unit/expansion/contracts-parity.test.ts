import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { catalogEntryStatusSchema, installResultSchema } from '#src/expansion/contracts.js';

const SKILL_MD = readFileSync(new URL('../../../skills/equip/SKILL.md', import.meta.url), 'utf-8');

function sort(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('expansion contracts parity (AC2)', () => {
  it('keeps every install result status routed in skills/equip/SKILL.md', () => {
    const statuses = sort(installResultSchema.options.map((option) => option.shape.status.value));

    expect(statuses).toEqual(
      sort([
        'catalog',
        'info',
        'installed',
        'updated',
        'already_installed',
        'already_up_to_date',
        'uninstalled',
        'not_equipped',
        'equipped',
        'catching_up',
        'already_equipped',
      ]),
    );

    for (const status of statuses) {
      expect(SKILL_MD).toContain(`\`${status}\``);
    }
  });

  it('keeps every catalog/info entry status routed in skills/equip/SKILL.md', () => {
    const statuses = sort(catalogEntryStatusSchema.options.map((option) => option.value));

    expect(statuses).toEqual(
      sort([
        'inactive',
        'installed-not-active',
        'unavailable',
        'disabled_pending_reinstall',
        'installing',
        'equipped',
        'catching_up',
        'not_equipped',
        'not_installed',
        'installed',
      ]),
    );

    for (const status of statuses) {
      expect(SKILL_MD).toContain(`\`${status}\``);
    }
  });
});
