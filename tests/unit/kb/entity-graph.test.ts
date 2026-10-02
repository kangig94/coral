import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendLog } from '#src/infra/backend-log.js';
import { parseEntityMetaMap } from '#src/kb/corpus/index/store.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

describe('entity-graph', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('degrades on malformed, invalid, and conflict-marked files without rewriting them', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-kb-entity-graph-'));
    const kb = createTestKbRuntime({
      markdownRoot: root,
      runtimeDir: root,
      db: openKbTestStoreDb(':memory:'),
    });
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    const malformed = '{';
    writeFileSync(kb.entityGraphPath(), malformed, 'utf-8');
    expect(kb.readEntityGraph()).toBeNull();
    expect(readFileSync(kb.entityGraphPath(), 'utf-8')).toBe(malformed);

    const invalidGraph = JSON.stringify({
      entityMeta: {
        'graph-rag': {
          type: 'not-a-real-type',
          description: 'Bad type.',
        },
      },
      relationships: [],
    });
    writeFileSync(kb.entityGraphPath(), invalidGraph, 'utf-8');
    expect(kb.readEntityGraph()).toBeNull();
    expect(readFileSync(kb.entityGraphPath(), 'utf-8')).toBe(invalidGraph);

    const conflicted = `<<<<<<< HEAD
{"entityMeta":{},"relationships":[]}
=======
{"entityMeta":{"graph-rag":{"type":"concept","description":"Graph-backed retrieval."}},"relationships":[]}
>>>>>>> incoming
`;
    writeFileSync(kb.entityGraphPath(), conflicted, 'utf-8');
    expect(kb.readEntityGraph()).toBeNull();
    expect(readFileSync(kb.entityGraphPath(), 'utf-8')).toBe(conflicted);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy.mock.calls[2]?.[0]).toContain('graph and community-derived features are disabled');

    rmSync(root, { recursive: true, force: true });
  });

  it('rejects reserved entityMeta keys from parsed graph files', () => {
    const value = JSON.parse(
      '{"__proto__":{"type":"concept","description":"Prototype-shaped entity."},"safe":{"type":"concept","description":"Safe entity."}}',
    );

    expect(() => parseEntityMetaMap(value)).toThrow('Invalid KB entity graph');
  });
});
