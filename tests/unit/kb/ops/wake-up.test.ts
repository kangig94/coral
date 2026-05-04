import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it } from 'vitest';

import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import type { WikiEntry } from '#src/kb/entry-types.js';
import { wikiEntryId } from '#src/kb/entry-types.js';
import { persistCorpusState } from '#src/kb/state/corpus-state.js';
import {
  createWakeUpCorpusConsumer,
  generateWakeUpPacket,
  parseCorpusSnapshotStamp,
  WAKE_UP_CONSUMER_ID,
  WAKE_UP_FALLBACK_MAX_BYTES,
  wakeUpPacketPath,
} from '#src/kb/ops/wake-up.js';
import type { KbProjectionInput } from '#src/kb/projection-input-contract.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import type { Database } from '#src/store/db.js';

const tempRoots: string[] = [];

function snapshot(overrides: Partial<KbCorpusSnapshot> = {}): KbCorpusSnapshot {
  return {
    snapshotId: overrides.snapshotId ?? 'snapshot-1',
    contentSeq: overrides.contentSeq ?? 1,
    metadataSeq: overrides.metadataSeq ?? 1,
    contentManifestHash: overrides.contentManifestHash ?? 'content-hash-1',
    metadataManifestHash: overrides.metadataManifestHash ?? 'metadata-hash-1',
  };
}

function createRuntime(): { kb: KbRuntime; db: Database; root: string; vault: string; runtimeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'coral-wake-up-'));
  tempRoots.push(root);
  const vault = join(root, 'vault');
  const runtimeDir = join(root, 'runtime');
  mkdirSync(vault, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  const db = createKbTestDb(runtimeDir);
  const kb = createTestKbRuntime({
    markdownRoot: vault,
    runtimeDir,
    db,
  });
  return { kb, db, root, vault, runtimeDir };
}

function wikiEntry(slug: string, updatedAt: string): WikiEntry {
  return {
    kind: 'wiki',
    slug,
    title: slug,
    tags: [],
    references_principles: [],
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt,
    knowledge: [],
    related: [],
  };
}

function wikiBody(firstParagraph: string, secondParagraph = 'Second paragraph should not appear.'): string {
  return ['## Understanding', '', firstParagraph, '', secondParagraph, '', '## Knowledge', ''].join('\n');
}

function wikiRaw(slug: string, title: string, updatedAt: string, understanding: string): string {
  return [
    '---',
    'tags: [wake]',
    'references_principles: []',
    'createdAt: 2026-05-04T00:00:00.000Z',
    `updatedAt: ${updatedAt}`,
    '---',
    `# ${title}`,
    '',
    wikiBody(understanding),
    '',
  ].join('\n');
}

function projectionInput(entries: readonly WikiEntry[]): KbProjectionInput {
  return {
    index: {
      entries: Object.fromEntries(entries.map((entry) => [wikiEntryId(entry.slug), entry])),
      principles: {},
      entityMeta: {},
      relationships: [],
    },
    records: entries.map((entry) => ({
      kind: 'wiki',
      entry,
      body: wikiBody(`${entry.slug} first paragraph.`),
      rawContent: '',
    })),
    communityFresh: false,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('wake-up packet', () => {
  it('registers a both-lane base corpus consumer and writes a stamped sorted cache', async () => {
    const { kb, db, vault } = createRuntime();
    try {
      writeFileSync(join(vault, 'identity.md'), 'Coral identity context.\n', 'utf-8');
      const target = snapshot();
      const consumer = createWakeUpCorpusConsumer(kb);

      expect(consumer).toMatchObject({
        id: WAKE_UP_CONSUMER_ID,
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'base',
        corpusInterest: 'both',
      });

      const result = await consumer.apply({
        snapshot: target,
        journalReader: { readCursor: () => 0 },
        corpusStateReader: {
          readConsumerCursor: () => target,
          readCurrentSnapshot: () => target,
        },
        projectionInput: projectionInput([
          wikiEntry('older', '2026-05-04T01:00:00.000Z'),
          wikiEntry('newer', '2026-05-04T02:00:00.000Z'),
        ]),
        signal: new AbortController().signal,
      });

      expect(result).toBeUndefined();
      const cached = readFileSync(wakeUpPacketPath(kb), 'utf-8');
      expect(parseCorpusSnapshotStamp(cached)).toEqual(target);
      expect(cached).toContain('Coral identity context.');
      expect(cached.indexOf('## newer (2026-05-04T02:00:00.000Z)')).toBeLessThan(
        cached.indexOf('## older (2026-05-04T01:00:00.000Z)'),
      );
      expect(cached).toContain('newer first paragraph.');
      expect(cached).not.toContain('Second paragraph should not appear.');
    } finally {
      db.close();
    }
  });

  it('returns no-advance stale without writing when the corpus snapshot changed before apply', async () => {
    const { kb, db } = createRuntime();
    try {
      const target = snapshot();
      const stale = snapshot({ snapshotId: 'snapshot-2', contentSeq: 2, contentManifestHash: 'content-hash-2' });
      const consumer = createWakeUpCorpusConsumer(kb);

      const result = await consumer.apply({
        snapshot: target,
        journalReader: { readCursor: () => 0 },
        corpusStateReader: {
          readConsumerCursor: () => target,
          readCurrentSnapshot: () => stale,
        },
        projectionInput: projectionInput([wikiEntry('stale', '2026-05-04T01:00:00.000Z')]),
        signal: new AbortController().signal,
      });

      expect(result).toEqual({ advance: false, reason: 'stale-snapshot' });
      expect(kb.storagePort.existsSync(wakeUpPacketPath(kb))).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns cached content when the wake-up cursor is caught up to the current snapshot', async () => {
    const { kb, db } = createRuntime();
    try {
      const current = snapshot();
      persistCorpusState(db, current, { now: () => new Date('2026-05-04T00:00:00.000Z') });
      db.prepare(
        `
          INSERT INTO consumer_cursors (
            consumer_id,
            authority,
            lane,
            corpus_interest,
            cursor,
            snapshot_id,
            content_seq,
            metadata_seq,
            content_manifest_hash,
            metadata_manifest_hash,
            registered_at,
            registration_kind
          ) VALUES (?, 'corpus', NULL, 'both', NULL, ?, ?, ?, ?, ?, ?, 'base')
        `,
      ).run(
        WAKE_UP_CONSUMER_ID,
        current.snapshotId,
        current.contentSeq,
        current.metadataSeq,
        current.contentManifestHash,
        current.metadataManifestHash,
        '2026-05-04T00:00:00.000Z',
      );
      const cached = `<!-- corpus-snapshot: snapshotId=${current.snapshotId} contentSeq=${current.contentSeq} metadataSeq=${current.metadataSeq} contentManifestHash=${current.contentManifestHash} metadataManifestHash=${current.metadataManifestHash} -->\nCached packet.\n`;
      writeFileSync(wakeUpPacketPath(kb), cached, 'utf-8');

      expect(await generateWakeUpPacket(kb)).toBe(cached);
    } finally {
      db.close();
    }
  });

  it('respects the WAKE_UP_FALLBACK_MAX_BYTES cap on a CJK-heavy fixture (overshoot is 1.2-1.7× target tokens, v1 limitation)', async () => {
    const { kb, db } = createRuntime();
    try {
      const wikiDir = join(kb.markdownRoot, 'wiki');
      mkdirSync(wikiDir, { recursive: true });
      const entries: Record<string, WikiEntry> = {};
      // 200 repetitions of a 6-character Korean phrase + space ≈ ~3KB per
      // wiki of UTF-8 bytes, large enough that 10 wikis combined far exceed
      // the byte cap and force truncation.
      const koreanUnderstanding = '안녕하세요 '.repeat(200);

      for (let index = 0; index < 10; index += 1) {
        const slug = `wiki-ko-${index.toString().padStart(2, '0')}`;
        const updatedAt = `2026-05-04T00:${String(index).padStart(2, '0')}:00.000Z`;
        entries[wikiEntryId(slug)] = wikiEntry(slug, updatedAt);
        writeFileSync(kb.wikiPath(slug), wikiRaw(slug, slug, updatedAt, koreanUnderstanding), 'utf-8');
      }

      kb.writeIndex({
        entries,
        principles: {},
        entityMeta: {},
        relationships: [],
      });

      const packet = await generateWakeUpPacket(kb);
      const body = packet.replace(/^<!--.*?-->\r?\n/s, '');
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(WAKE_UP_FALLBACK_MAX_BYTES);
    } finally {
      db.close();
    }
  });

  it('regenerates a 100-wiki cold cache inside the 500ms wall-clock target', async () => {
    const { kb, db } = createRuntime();
    try {
      const wikiDir = join(kb.markdownRoot, 'wiki');
      mkdirSync(wikiDir, { recursive: true });
      const entries: Record<string, WikiEntry> = {};
      const understanding = 'Wake-up context '.repeat(64);

      for (let index = 0; index < 100; index += 1) {
        const slug = `wiki-${index.toString().padStart(3, '0')}`;
        const updatedAt = `2026-05-04T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(
          2,
          '0',
        )}:00.000Z`;
        entries[wikiEntryId(slug)] = wikiEntry(slug, updatedAt);
        writeFileSync(kb.wikiPath(slug), wikiRaw(slug, slug, updatedAt, `${understanding}${slug}.`), 'utf-8');
      }

      kb.writeIndex({
        entries,
        principles: {},
        entityMeta: {},
        relationships: [],
      });

      const started = performance.now();
      const packet = await generateWakeUpPacket(kb);
      const elapsedMs = performance.now() - started;

      expect(elapsedMs).toBeLessThanOrEqual(500);
      expect(parseCorpusSnapshotStamp(packet)).not.toBeNull();
      expect(packet).toContain('## wiki-099');
      expect(Buffer.byteLength(packet.replace(/^<!--.*?-->\r?\n/s, ''), 'utf8')).toBeLessThanOrEqual(
        WAKE_UP_FALLBACK_MAX_BYTES,
      );
    } finally {
      db.close();
    }
  });
});
