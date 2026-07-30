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

function skillSection(heading: string, nextHeading: string): string {
  const start = SKILL_MD.indexOf(heading);
  const end = SKILL_MD.indexOf(nextHeading, start + heading.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return SKILL_MD.slice(start, end);
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

  it('keeps install-only consent and runtime-download routing inside the update protocol', () => {
    expect(
      catalogEntrySchema.parse({
        id: 'kiwi',
        name: 'kiwi',
        description: 'Korean analyzer',
        activation: 'none',
        status: 'not_installed',
        version: '0.23.0',
        confirmDownload: 'Download the pinned runtime artifacts?',
      }),
    ).toMatchObject({
      confirmDownload: 'Download the pinned runtime artifacts?',
    });
    const equipSection = skillSection('### `<package>`', '### `--update <package>`');
    expect(equipSection).toContain('the current entry includes `confirmDownload`');
    expect(equipSection).toContain('show that message exactly');
    expect(equipSection).toContain("`method: 'runtime-download'`");
    expect(equipSection).toContain('`targetDir`');
    expect(equipSection).toContain('`command`');
    expect(equipSection).toContain('`installed`');
    expect(equipSection).toContain('`updated`');
    expect(equipSection).toContain('no coding-agent restart is required');
    expect(equipSection).toContain('When `ko` is enabled and the backend is active');
    expect(equipSection).toContain('this command started neither a download nor a reindex');
    expect(equipSection).toContain('Do not promise an analyzer upgrade');
    expect(equipSection).toContain('`coral-cli backend shutdown`');

    const updateSection = skillSection('### `--update <package>`', '### `info <package>`');
    expect(updateSection).toContain('`confirmDownload`');
    expect(updateSection).toContain('show that message exactly');
    expect(updateSection).toContain("`method: 'runtime-download'`");
    expect(updateSection).toContain('`targetDir`');
    expect(updateSection).toContain('`command`');
    expect(updateSection).toContain('no coding-agent restart is required');
    expect(updateSection).toContain('only when `ko` is enabled and the backend is active');
    expect(updateSection).toContain('`installed`');
    expect(updateSection).toContain('`updated`');
    expect(updateSection).toContain('`already_installed`');
    expect(updateSection).toContain('`already_up_to_date`');
    expect(updateSection).toContain('For `installed` and `updated`');
    expect(updateSection).toContain('this command started neither a download nor a reindex');
    expect(updateSection).toContain('do not promise an analyzer upgrade');

    const infoSection = skillSection('### `info <package>`', '### `uninstall <equipment-name>`');
    expect(infoSection).toContain('`confirmDownload`');
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
