import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  catalogEntrySchema,
  catalogEntryStatusSchema,
  installResultSchema,
  removeExpansionCatalogResultSchema,
} from '#src/expansion/rpc-contract.js';

const SKILL_MD = readFileSync(new URL('../../../clients/skills/equip/SKILL.md', import.meta.url), 'utf-8');

function sort(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('expansion contracts parity', () => {
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

  it('keeps capability descriptors and runtime status as separate catalog entry siblings', () => {
    expect(
      catalogEntrySchema.parse({
        id: 'dummy-capability-provider',
        name: 'dummy-capability-provider',
        tier: 'installed',
        description: 'Dummy capability provider',
        activation: 'equip',
        status: 'inactive',
        provides: {
          capabilities: [{ name: 'vendor.cache', label: 'Vendor Cache' }],
        },
        capabilityStatus: [
          {
            name: 'vendor.cache',
            namespace: 'external',
            declared: true,
            bound: false,
            declaredByManifest: 'dummy-capability-provider',
          },
        ],
      }),
    ).toMatchObject({
      provides: {
        capabilities: [{ name: 'vendor.cache', namespace: 'external' }],
      },
      capabilityStatus: [{ name: 'vendor.cache', declared: true, bound: false }],
    });
  });

  it('parses coordinator-internal catalog removal statuses without adding public install statuses', () => {
    expect(removeExpansionCatalogResultSchema.parse({ status: 'removed' })).toEqual({ status: 'removed' });
    expect(removeExpansionCatalogResultSchema.parse({ status: 'immutable' })).toEqual({ status: 'immutable' });
    expect(
      removeExpansionCatalogResultSchema.parse({
        status: 'blocked',
        target: 'provider',
        capabilities: [
          {
            capability: 'vendor.cache',
            dependents: [{ expansion: 'consumer', edgeKind: 'read', source: 'onboarding', state: 'active' }],
          },
        ],
        dependents: [
          {
            capability: 'vendor.cache',
            expansion: 'consumer',
            edgeKind: 'read',
            source: 'onboarding',
            state: 'active',
          },
        ],
      }),
    ).toMatchObject({ status: 'blocked', dependents: [{ expansion: 'consumer' }] });
    expect(removeExpansionCatalogResultSchema.parse({ status: 'unknown' })).toEqual({ status: 'unknown' });
  });
});
