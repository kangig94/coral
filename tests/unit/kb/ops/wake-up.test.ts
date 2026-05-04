import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
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
  updatedAt: string;
  understanding: string;
  knowledgeBody?: string;
}

function wikiRaw(fixture: WikiFixture): string {
  return [
    '---',
    'tags: [wake]',
    'references_principles: []',
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
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      seedWiki(kb, { slug: 'kangig94-coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'Alpha understanding.' });

      expect(await generateWakeUpPacket(kb, undefined)).toBe('');
    } finally {
      db.close();
    }
  });

  it('looks up the project wiki by slug and emits its Understanding section', async () => {
    const { kb, db } = createRuntime();
    try {
      seedWiki(kb, { slug: 'kangig94-coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'In-scope understanding.' });
      seedWiki(kb, { slug: 'other-subject', updatedAt: '2026-05-04T02:00:00.000Z', understanding: 'Subject understanding.' });

      const packet = await generateWakeUpPacket(kb, 'kangig94-coral');

      expect(packet).toContain('## kangig94-coral (2026-05-04T01:00:00.000Z)');
      expect(packet).toContain('In-scope understanding.');
      expect(packet).not.toContain('other-subject');
      expect(packet).not.toContain('Subject understanding.');
    } finally {
      db.close();
    }
  });

  it('returns an empty packet when the project wiki is absent and identity is absent', async () => {
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

  it('prepends identity.md content before the wiki block', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      seedWiki(kb, { slug: 'kangig94-coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'In-scope understanding.' });

      const packet = await generateWakeUpPacket(kb, 'kangig94-coral');

      expect(packet.indexOf('Coral identity context.')).toBeLessThan(packet.indexOf('## kangig94-coral'));
    } finally {
      db.close();
    }
  });

  it('returns identity content alone when the project wiki is absent', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');

      const packet = await generateWakeUpPacket(kb, 'kangig94-coral');

      expect(packet).toBe('Coral identity context.\n\n');
    } finally {
      db.close();
    }
  });
});

describe('hook ↔ backend wake-up parity', () => {
  it('readProjectScopedWakeUp matches generateWakeUpPacket byte-for-byte (project wiki + identity.md)', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      seedWiki(kb, { slug: 'kangig94-coral', updatedAt: '2026-05-04T01:00:00.000Z', understanding: 'Project understanding.' });
      seedWiki(kb, { slug: 'other-subject', updatedAt: '2026-05-04T03:00:00.000Z', understanding: 'Subject understanding.' });

      const backendOutput = await generateWakeUpPacket(kb, 'kangig94-coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94-coral');

      expect(hookPayload ?? '').toBe(backendOutput);
    } finally {
      db.close();
    }
  });

  it('readProjectScopedWakeUp matches generateWakeUpPacket for the (no wiki, no identity) empty case', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      const backendOutput = await generateWakeUpPacket(kb, 'kangig94-coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94-coral');

      expect(hookPayload ?? '').toBe(backendOutput);
    } finally {
      db.close();
    }
  });

  it('readProjectScopedWakeUp matches generateWakeUpPacket for the (no wiki, identity PRESENT) case', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');

      const backendOutput = await generateWakeUpPacket(kb, 'kangig94-coral');
      const hookPayload = readProjectScopedWakeUp(vault, 'kangig94-coral');

      expect(hookPayload ?? '').toBe(backendOutput);
      expect(backendOutput).toContain('Coral identity context.');
    } finally {
      db.close();
    }
  });
});
