import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import { generateWakeUpPacket } from '#src/kb/ops/wake-up.js';
// @ts-expect-error — hooks lib is .mjs without TypeScript types; direct import for parity test.
import { readProjectScopedWakeUp } from '../../../../clients/hooks/lib/wake-up-read.mjs';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
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
  const db = openKbTestStoreDb(':memory:');
  const kb = createTestKbRuntime({
    markdownRoot: vault,
    runtimeDir,
    db,
  });
  return { kb, db, root, vault, runtimeDir };
}

interface WikiFixture {
  slug: string;
  updatedAt: string;
  understanding: string;
  knowledgeBody?: string;
}

function wikiRaw(fixture: WikiFixture): string {
  return [
    '---',
    'tags: [wake]',
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

function seedWiki(kb: KbRuntime, fixture: WikiFixture): void {
  writeFileSync(kb.wikiPath(fixture.slug), wikiRaw(fixture), 'utf-8');
}

afterEach(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('generateWakeUpPacket', () => {
  it('returns an empty string when projectSlug is undefined', async () => {
    const { kb, db } = createRuntime();
    try {
      seedWiki(kb, {
        slug: 'kangig94-coral',
        updatedAt: '2026-05-04T01:00:00.000Z',
        understanding: 'Alpha understanding.',
      });

      expect(await generateWakeUpPacket(kb, undefined)).toBe('');
    } finally {
      db.close();
    }
  });

  it('looks up the project wiki by slug and emits its Understanding section', async () => {
    const { kb, db } = createRuntime();
    try {
      seedWiki(kb, {
        slug: 'kangig94-coral',
        updatedAt: '2026-05-04T01:00:00.000Z',
        understanding: 'In-scope understanding.',
      });
      seedWiki(kb, {
        slug: 'other-subject',
        updatedAt: '2026-05-04T02:00:00.000Z',
        understanding: 'Subject understanding.',
      });

      const packet = await generateWakeUpPacket(kb, 'kangig94-coral');

      expect(packet).toContain('## project wiki: kangig94-coral (2026-05-04T01:00:00.000Z)');
      expect(packet).toContain('In-scope understanding.');
      expect(packet).not.toContain('## project wiki: other-subject');
      expect(packet).not.toContain('Subject understanding.');
    } finally {
      db.close();
    }
  });

  it('returns an empty packet when the project wiki is absent', async () => {
    const { kb, db } = createRuntime();
    try {
      seedWiki(kb, { slug: 'foreign', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'Foreign understanding.' });

      expect(await generateWakeUpPacket(kb, 'kangig94-coral')).toBe('');
    } finally {
      db.close();
    }
  });

  it('emits the full Understanding section, not just the first paragraph', async () => {
    const { kb, db } = createRuntime();
    try {
      const understanding = ['First paragraph.', '', 'Second paragraph.', '', 'Third paragraph.'].join('\n');
      seedWiki(kb, { slug: 'kangig94-coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding });

      const packet = await generateWakeUpPacket(kb, 'kangig94-coral');

      expect(packet).toContain('First paragraph.');
      expect(packet).toContain('Second paragraph.');
      expect(packet).toContain('Third paragraph.');
    } finally {
      db.close();
    }
  });
});

describe('hook ↔ backend wake-up parity', () => {
  it('readProjectScopedWakeUp matches generateWakeUpPacket byte-for-byte when the project wiki exists', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      seedWiki(kb, {
        slug: 'kangig94-coral',
        updatedAt: '2026-05-04T01:00:00.000Z',
        understanding: 'Project understanding.',
      });
      seedWiki(kb, {
        slug: 'other-subject',
        updatedAt: '2026-05-04T03:00:00.000Z',
        understanding: 'Subject understanding.',
      });

      const backendOutput = await generateWakeUpPacket(kb, 'kangig94-coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94-coral');

      expect(hookPayload ?? '').toBe(backendOutput);
    } finally {
      db.close();
    }
  });

  it('readProjectScopedWakeUp matches generateWakeUpPacket for the empty case (no wiki)', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      const backendOutput = await generateWakeUpPacket(kb, 'kangig94-coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94-coral');

      expect(hookPayload ?? '').toBe(backendOutput);
    } finally {
      db.close();
    }
  });
});
