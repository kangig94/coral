import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import type { WikiEntry } from '#src/kb/entry-types.js';
import { wikiEntryId } from '#src/kb/entry-types.js';
import { generateWakeUpPacket } from '#src/kb/ops/wake-up.js';
// @ts-expect-error — hooks lib is .mjs without TypeScript types; direct import for parity test.
import { readProjectScopedWakeUp } from '../../../../hooks/lib/wake-up-read.mjs';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import type { Database } from '#src/store/db.js';

const tempRoots: string[] = [];

function createRuntime(): { kb: KbRuntime; db: Database; root: string; vault: string; runtimeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-wake-up-'));
  tempRoots.push(root);
  const vault = join(root, 'vault');
  const runtimeDir = join(root, 'runtime');
  mkdirSync(vault, { recursive: true });
  mkdirSync(join(vault, 'wiki'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const db = createKbTestDb(runtimeDir);
  const kb = createTestKbRuntime({
    markdownRoot: vault,
    runtimeDir,
    db,
  });
  return { kb, db, root, vault, runtimeDir };
}

interface WikiFixture {
  slug: string;
  project: string;
  updatedAt: string;
  understanding: string;
  knowledgeBody?: string;
}

function wikiRaw(fixture: WikiFixture): string {
  return [
    '---',
    'tags: [wake]',
    'references_principles: []',
    `project: ${fixture.project}`,
    'createdAt: 2026-05-04T00:00:00.000Z',
    `updatedAt: ${fixture.updatedAt}`,
    '---',
    `# ${fixture.slug}`,
    '',
    '## Understanding',
    '',
    fixture.understanding,
    '',
    '## Knowledge',
    '',
    fixture.knowledgeBody ?? '',
  ].join('\n');
}

function wikiIndexEntry(fixture: WikiFixture): WikiEntry {
  return {
    kind: 'wiki',
    slug: fixture.slug,
    title: fixture.slug,
    tags: ['wake'],
    references_principles: [],
    project: fixture.project,
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: fixture.updatedAt,
    knowledge: [],
    related: [],
  };
}

function seedWikis(kb: KbRuntime, fixtures: readonly WikiFixture[]): void {
  for (const fixture of fixtures) {
    writeFileSync(kb.wikiPath(fixture.slug), wikiRaw(fixture), 'utf-8');
  }
  kb.writeIndex({
    entries: Object.fromEntries(fixtures.map((fixture) => [wikiEntryId(fixture.slug), wikiIndexEntry(fixture)])),
    principles: {},
    entityMeta: {},
    relationships: [],
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generateWakeUpPacket', () => {
  it('returns an empty string when project is undefined', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      seedWikis(kb, [
        { slug: 'alpha', project: 'kangig94/coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'Alpha understanding.' },
      ]);

      expect(await generateWakeUpPacket(kb, undefined)).toBe('');
    } finally {
      db.close();
    }
  });

  it('filters wikis by project: only matching wikis are emitted', async () => {
    const { kb, db } = createRuntime();
    try {
      seedWikis(kb, [
        { slug: 'in-scope', project: 'kangig94/coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'In-scope understanding.' },
        { slug: 'out-of-scope', project: 'acme/repo', updatedAt: '2026-05-04T02:00:00.000Z', understanding: 'Out-of-scope understanding.' },
      ]);

      const packet = await generateWakeUpPacket(kb, 'kangig94/coral');

      expect(packet).toContain('## in-scope (2026-05-04T01:00:00.000Z)');
      expect(packet).toContain('In-scope understanding.');
      expect(packet).not.toContain('out-of-scope');
      expect(packet).not.toContain('Out-of-scope understanding.');
    } finally {
      db.close();
    }
  });

  it('returns an empty packet when no wikis match the project and identity is absent', async () => {
    const { kb, db } = createRuntime();
    try {
      seedWikis(kb, [
        { slug: 'foreign', project: 'acme/repo', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'Foreign understanding.' },
      ]);

      expect(await generateWakeUpPacket(kb, 'kangig94/coral')).toBe('');
    } finally {
      db.close();
    }
  });

  it('emits the full Understanding section, not just the first paragraph', async () => {
    const { kb, db } = createRuntime();
    try {
      const understanding = ['First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.'].join('\n');
      seedWikis(kb, [
        { slug: 'multi', project: 'kangig94/coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding },
      ]);

      const packet = await generateWakeUpPacket(kb, 'kangig94/coral');

      expect(packet).toContain('First paragraph.');
      expect(packet).toContain('Second paragraph.');
      expect(packet).toContain('Third paragraph.');
    } finally {
      db.close();
    }
  });

  it('prepends identity.md content before wiki blocks', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      seedWikis(kb, [
        { slug: 'in-scope', project: 'kangig94/coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'In-scope understanding.' },
      ]);

      const packet = await generateWakeUpPacket(kb, 'kangig94/coral');

      expect(packet.indexOf('Coral identity context.')).toBeLessThan(packet.indexOf('## in-scope'));
    } finally {
      db.close();
    }
  });

  it('returns identity content alone when project resolves but zero wikis match', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      seedWikis(kb, [
        { slug: 'foreign', project: 'acme/repo', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'Foreign understanding.' },
      ]);

      const packet = await generateWakeUpPacket(kb, 'kangig94/coral');

      expect(packet).toBe('Coral identity context.\n\n');
    } finally {
      db.close();
    }
  });

  it('sorts matched wikis by updatedAt DESC with slug ASC tiebreak', async () => {
    const { kb, db } = createRuntime();
    try {
      seedWikis(kb, [
        { slug: 'older', project: 'kangig94/coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'older.' },
        { slug: 'newer', project: 'kangig94/coral', updatedAt: '2026-05-04T02:00:00.000Z', understanding: 'newer.' },
        { slug: 'beta-tied', project: 'kangig94/coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'beta tied.' },
      ]);

      const packet = await generateWakeUpPacket(kb, 'kangig94/coral');

      const newerIdx = packet.indexOf('## newer (2026-05-04T02:00:00.000Z)');
      const betaIdx = packet.indexOf('## beta-tied (2026-05-04T01:00:00.000Z)');
      const olderIdx = packet.indexOf('## older (2026-05-04T01:00:00.000Z)');
      expect(newerIdx).toBeGreaterThanOrEqual(0);
      expect(betaIdx).toBeGreaterThanOrEqual(0);
      expect(olderIdx).toBeGreaterThanOrEqual(0);
      // updatedAt DESC: newer first; among the two tied at 01:00, slug ASC ⇒ beta-tied before older.
      expect(newerIdx).toBeLessThan(betaIdx);
      expect(betaIdx).toBeLessThan(olderIdx);
    } finally {
      db.close();
    }
  });
});

describe('hook ↔ backend wake-up parity', () => {
  it('readProjectScopedWakeUp matches generateWakeUpPacket byte-for-byte (project + N wikis + identity.md)', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      seedWikis(kb, [
        { slug: 'older', project: 'kangig94/coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'Older understanding.' },
        { slug: 'newer', project: 'kangig94/coral', updatedAt: '2026-05-04T02:00:00.000Z', understanding: 'Newer understanding.' },
        { slug: 'foreign', project: 'acme/repo', updatedAt: '2026-05-04T03:00:00.000Z', understanding: 'Foreign understanding.' },
      ]);

      const backendOutput = await generateWakeUpPacket(kb, 'kangig94/coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94/coral');

      expect(hookPayload ?? '').toBe(backendOutput);
    } finally {
      db.close();
    }
  });

  it('readProjectScopedWakeUp matches generateWakeUpPacket for the (zero wikis, no identity) empty case', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      const backendOutput = await generateWakeUpPacket(kb, 'kangig94/coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94/coral');

      expect(hookPayload ?? '').toBe(backendOutput);
    } finally {
      db.close();
    }
  });

  it('readProjectScopedWakeUp matches generateWakeUpPacket for the (zero wikis, identity PRESENT) case', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      // No wikis seeded — but identity.md exists. Both backend and hook must
      // emit identity content alone with the byte-locked `\n\n` separator.

      const backendOutput = await generateWakeUpPacket(kb, 'kangig94/coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94/coral');

      expect(hookPayload ?? '').toBe(backendOutput);
      expect(backendOutput).toContain('Coral identity context.');
    } finally {
      db.close();
    }
  });
});
