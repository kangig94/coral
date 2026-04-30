import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsumerDriver } from '#src/coordinator/consumer-driver.js';
import { createCorpusAuthorityBaselineStore } from '#src/kb/corpus/rescan/authority-baseline.js';
import { detectProjectionArtifactLag } from '#src/kb/corpus/rescan/drift.js';
import { createCorpusMarkdownFileScan, createCorpusScanView } from '#src/kb/corpus/rescan/scan.js';
import type { KbCorpusSnapshot } from '#src/kb/contract.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-drift-split-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

const SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: 'snapshot-a',
  contentSeq: 1,
  metadataSeq: 1,
  contentManifestHash: 'content-hash',
  metadataManifestHash: 'metadata-hash',
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('drift signal split', () => {
  it('rebuilds the corpus authority baseline byte-identically from markdown authority', () => {
    const db = createKbTestDb(tempRoot());
    const scan = createCorpusScanView({
      markdownFiles: [
        createCorpusMarkdownFileScan({
          kind: 'note',
          path: 'notes/coral-note.md',
          content: [
            '---',
            'tags: [coral]',
            'principles: []',
            'source:',
            '  - kangig94/coral',
            'createdAt: 2026-04-01T00:00:00.000Z',
            'updatedAt: 2026-04-01T00:00:00.000Z',
            'entrySeq: 1',
            '---',
            '# Coral Note',
            '',
            'Body.',
            '',
          ].join('\n'),
        }),
        createCorpusMarkdownFileScan({
          kind: 'source',
          path: 'sources/sqlite-source.md',
          content: [
            '---',
            'title: SQLite Source',
            'type: article',
            'tags: [sqlite]',
            'importedAt: 2026-04-01',
            'entrySeq: 2',
            '---',
            '# SQLite Source',
            '',
            'Body.',
            '',
          ].join('\n'),
        }),
      ],
    });
    const store = createCorpusAuthorityBaselineStore(db);
    const before = [...store.rebuild(scan).entries()].sort();

    db.prepare('DELETE FROM kb_corpus_authority_baseline').run();
    const after = [...store.rebuild(scan).entries()].sort();

    expect(after).toEqual(before);
  });

  it('classifies projection artifact lag separately from authority drift inputs', () => {
    const lag = detectProjectionArtifactLag({ getCorpusStateSnapshot: () => SNAPSHOT }, [
      {
        artifactId: 'engine:cache',
        kind: 'projection-cache',
        targetConsumerIds: ['consumer-a'],
        corpusInterest: 'content',
        artifactPaths: ['/tmp/cache'],
        expectedProjectionIdentityHash: 'expected',
        freshness: {
          status: 'present',
          projected: {
            ...SNAPSHOT,
            projectionIdentityHash: 'older-projection',
          },
        },
      },
    ]);

    expect(lag).toEqual([
      {
        artifactId: 'engine:cache',
        targetConsumerIds: ['consumer-a'],
        diagnostic: expect.stringContaining('projection identity'),
      },
    ]);
  });

  it('forces unchanged-snapshot corpus apply through waitFreshUntil generation without seq bumps', async () => {
    const db = createKbTestDb(tempRoot());
    const driver = new ConsumerDriver({ db });
    const secondStarted = deferred();
    const releaseSecond = deferred();
    let applyCount = 0;
    driver.register({
      id: 'corpus-a',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'base',
      corpusInterest: 'content',
      async apply() {
        applyCount += 1;
        if (applyCount === 2) {
          secondStarted.resolve();
          await releaseSecond.promise;
        }
      },
    });

    driver.notifyCorpus(SNAPSHOT);
    await driver.waitFreshUntil('corpus', SNAPSHOT, 'corpus-a', 500);
    expect(applyCount).toBe(1);

    const forced = driver.forceCorpusApply(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: ['corpus-a'],
    });
    await driver.waitFreshUntil('corpus', SNAPSHOT, 'corpus-a', 50);
    await secondStarted.promise;
    const generationWait = driver.waitFreshUntil(
      'corpus',
      { snapshot: SNAPSHOT, atLeastGeneration: forced.generation },
      'corpus-a',
      500,
    );

    let generationResolved = false;
    void generationWait.then(() => {
      generationResolved = true;
    });
    await Promise.resolve();
    expect(generationResolved).toBe(false);

    releaseSecond.resolve();
    await generationWait;
    expect(applyCount).toBe(2);
  });

  it('surfaces force-apply lifecycle edges through existing waitFreshUntil errors', async () => {
    const stoppedDb = createKbTestDb(tempRoot());
    const stoppedDriver = new ConsumerDriver({ db: stoppedDb });
    const stopped = stoppedDriver.register({
      id: 'stopped-corpus',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'base',
      corpusInterest: 'content',
      async apply() {},
    });
    await stopped.stop();
    const stoppedForced = stoppedDriver.forceCorpusApply(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: ['stopped-corpus'],
    });
    try {
      stoppedDriver.waitFreshUntil(
        'corpus',
        { snapshot: SNAPSHOT, atLeastGeneration: stoppedForced.generation },
        'stopped-corpus',
      );
      throw new Error('Expected stopped consumer wait to throw.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'consumer_wait_unsupported' });
    }

    const unregisteredDb = createKbTestDb(tempRoot());
    const unregisteredDriver = new ConsumerDriver({ db: unregisteredDb });
    const unregistered = unregisteredDriver.register({
      id: 'unregistered-corpus',
      authority: 'corpus',
      kind: 'apply',
      registrationKind: 'expansion',
      corpusInterest: 'content',
      async apply() {},
    });
    const unregisteredForced = unregisteredDriver.forceCorpusApply(SNAPSHOT, {
      reason: 'projection-artifact-lag',
      consumers: ['unregistered-corpus'],
    });
    await unregistered.stop();
    await unregistered.unregister();

    try {
      unregisteredDriver.waitFreshUntil(
        'corpus',
        { snapshot: SNAPSHOT, atLeastGeneration: unregisteredForced.generation },
        'unregistered-corpus',
      );
      throw new Error('Expected unregistered consumer wait to throw.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'consumer_not_registered' });
    }
  });
});
