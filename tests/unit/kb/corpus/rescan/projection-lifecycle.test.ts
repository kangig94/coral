import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '#src/store/db.js';
import type { KbIndexState, KbRuntime } from '#src/kb/contract.js';
import type * as ScanWorkerModule from '#src/kb/corpus/rescan/scan-worker.js';
import { applyMutationLane, captureIndexStateSnapshot, withoutTextStaleReason } from '#src/kb/corpus/lanes.js';
import { EMPTY_GENERATED_COMMUNITY_FRESHNESS } from '#src/kb/curate/community/generated-projection-store.js';
import { noteEntryId } from '#src/kb/entry-types.js';
import type { CorpusProjectionCommitFaultPhase } from '#src/kb/corpus/projection-lifecycle.js';
import { update } from '#src/kb/ops/update.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';

const scanGate = vi.hoisted(() => {
  let releaseScan: (() => void) | null = null;
  let markStarted: (() => void) | null = null;
  return {
    enabled: false,
    insideMutationLock: false,
    forbiddenLockWork: [] as string[],
    waitForRelease: null as Promise<void> | null,
    started: null as Promise<void> | null,
    arm() {
      this.enabled = true;
      this.waitForRelease = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      this.started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
    },
    notifyStarted() {
      markStarted?.();
    },
    assertUnlocked(label: string) {
      if (this.insideMutationLock) {
        this.forbiddenLockWork.push(label);
      }
    },
    release() {
      this.enabled = false;
      releaseScan?.();
    },
    reset() {
      this.enabled = false;
      this.insideMutationLock = false;
      this.forbiddenLockWork = [];
      this.waitForRelease = null;
      this.started = null;
      releaseScan = null;
      markStarted = null;
    },
  };
});

vi.mock('#src/kb/corpus/rescan/scan-worker.js', async () => {
  const actual = await vi.importActual<typeof ScanWorkerModule>('#src/kb/corpus/rescan/scan-worker.js');
  return {
    ...actual,
    buildCorpusScanViewInWorker: vi.fn(async (...args: Parameters<typeof actual.buildCorpusScanViewInWorker>) => {
      scanGate.assertUnlocked('corpus scan');
      if (scanGate.enabled) {
        scanGate.notifyStarted();
        await scanGate.waitForRelease;
      }
      return actual.buildCorpusScanViewInWorker(...args);
    }),
  };
});

const tempRoots: string[] = [];
const openDatabases: Database[] = [];

async function loadLifecycleModule() {
  return import('#src/kb/corpus/rescan/index.js');
}

function createHarness(): { root: string; runtimeDir: string; db: Database; kb: KbRuntime } {
  const root = mkdtempSync(join(tmpdir(), 'coral-kb-projection-lifecycle-'));
  const runtimeDir = join(root, 'runtime');
  const markdownRoot = join(root, 'vault');
  mkdirSync(join(markdownRoot, 'notes'), { recursive: true });
  tempRoots.push(root);
  const db = createKbTestDb(runtimeDir);
  openDatabases.push(db);
  const { kb } = createKbTestRuntime({ markdownRoot, runtimeDir, db });
  return { root: markdownRoot, runtimeDir, db, kb };
}

function reopenHarness(input: { root: string; runtimeDir: string; db: Database }): { db: Database; kb: KbRuntime } {
  input.db.close();
  const index = openDatabases.indexOf(input.db);
  if (index >= 0) {
    openDatabases.splice(index, 1);
  }
  const db = createKbTestDb(input.runtimeDir);
  openDatabases.push(db);
  const { kb } = createKbTestRuntime({ markdownRoot: input.root, runtimeDir: input.runtimeDir, db });
  return { db, kb };
}

function writeNote(root: string, slug: string, body: string): void {
  writeFileSync(
    join(root, 'notes', `${slug}.md`),
    [
      '---',
      'tags: [projection]',
      'principles: []',
      'source:',
      '  - kangig94/coral',
      'createdAt: 2026-06-01T00:00:00.000Z',
      'updatedAt: 2026-06-01T00:00:00.000Z',
      'entrySeq: 1',
      '---',
      '# Projection Note',
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
}

function generatedCommunityDocument(content: string) {
  return {
    slug: 'generated-g2',
    title: 'Generated G2',
    level: 1,
    members: ['fresh'],
    createdAt: '2026-06-01',
    updatedAt: '2026-06-01',
    content,
  };
}

function manifestCommitId(kb: KbRuntime): string | null {
  return (
    kb as unknown as { manifestAuthority: { getCurrentSurfaceCommitId(): string | null } }
  ).manifestAuthority.getCurrentSurfaceCommitId();
}

function projectedNextState(kb: KbRuntime, externalMutation: Parameters<typeof applyMutationLane>[1]): KbIndexState {
  return applyMutationLane(withoutTextStaleReason(kb.readIndexState()), externalMutation);
}

const CORPUS_PROJECTION_FAULT_PHASES = [
  'pending',
  'index_renamed',
  'index_adopted',
  'baseline_adopted',
  'manifest_adopted',
  'state_persisted',
  'state_written',
  'committed',
] as const satisfies readonly CorpusProjectionCommitFaultPhase[];

afterEach(() => {
  vi.restoreAllMocks();
  scanGate.reset();
  for (const db of openDatabases.splice(0).reverse()) {
    db.close();
  }
  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('corpus projection lifecycle', () => {
  it('lets kb update complete while corpus-scale scan work is in progress', async () => {
    const { performRescan } = await loadLifecycleModule();
    const { kb, root } = createHarness();
    writeNote(root, 'projection-note', 'Initial body.');

    scanGate.arm();
    const rebuild = performRescan(kb, captureIndexStateSnapshot(kb.readIndexState()));
    await scanGate.started;

    const startedAt = Date.now();
    await update(kb, { note: 'projection-note', content: 'Updated while scan is gated.' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    scanGate.release();
    await expect(rebuild).resolves.toMatchObject({ status: 'discarded', reason: 'stale_seq' });
    expect(kb.readIndexState().textStaleReason).toBe('KB text snapshot is stale after kb_update.');
  });

  it('discards a candidate when seq CAS is lost and leaves freshness stale for retry', async () => {
    const { deriveCorpusProjection, stageCorpusProjectionArtifacts, commitCorpusProjection } =
      await loadLifecycleModule();
    const { kb, root } = createHarness();
    writeNote(root, 'projection-note', 'Initial body.');

    const startSeq = captureIndexStateSnapshot(kb.readIndexState());
    const candidate = await deriveCorpusProjection(kb, startSeq);
    const staged = stageCorpusProjectionArtifacts(kb, candidate);

    await kb.withMutationLock(() => {
      kb.recordMutationCommitted('metadata', 'concurrent metadata mutation');
    });

    const result = await commitCorpusProjection(kb, staged);

    expect(result).toMatchObject({ status: 'discarded', reason: 'stale_seq' });
    expect(kb.readIndex()).toBeNull();
    expect(kb.readIndexState().textStaleReason).toBe('concurrent metadata mutation');
    expect(kb.corpusAuthorityBaseline.read()).toEqual(new Map());
    expect(kb.generatedCommunityProjectionStore.readActiveFreshness()).toEqual(EMPTY_GENERATED_COMMUNITY_FRESHNESS);
    expect(existsSync(staged.stagedIndex.stagingDir)).toBe(false);

    const retryCandidate = await deriveCorpusProjection(kb, captureIndexStateSnapshot(kb.readIndexState()));
    const retry = await commitCorpusProjection(kb, stageCorpusProjectionArtifacts(kb, retryCandidate));
    expect(retry.status).toBe('committed');
    expect(kb.readIndex()?.entries[noteEntryId('projection-note')]).toBeDefined();
    expect(kb.readIndexState().textStaleReason).toBeUndefined();
  });

  it('discards a G1-derived candidate after generated generation G2 adopts without clearing G2 freshness', async () => {
    const { deriveCorpusProjection, stageCorpusProjectionArtifacts, commitCorpusProjection } =
      await loadLifecycleModule();
    const { kb, root } = createHarness();
    writeNote(root, 'projection-note', 'Initial body.');

    const startSeq = captureIndexStateSnapshot(kb.readIndexState());
    const candidate = await deriveCorpusProjection(kb, startSeq);
    const staged = stageCorpusProjectionArtifacts(kb, candidate);
    expect(candidate.priorGeneratedGeneration).toBe(0);

    const currentSnapshot = kb.captureCorpusSnapshot();
    const generated = kb.generatedCommunityProjectionStore.stageGeneration({
      snapshot: currentSnapshot,
      topologyHash: 'topology-g2',
      documents: [
        generatedCommunityDocument(
          [
            '---',
            'coralGeneratedCommunity: true',
            'createdAt: 2026-06-01',
            'updatedAt: 2026-06-01',
            'level: 1',
            '---',
            '# Generated G2',
            '',
            '## Members',
            '- #fresh',
            '',
          ].join('\n'),
        ),
      ],
    });
    await kb.withMutationLock(() => {
      const adopted = kb.generatedCommunityProjectionStore.adoptStagedGeneration(generated, currentSnapshot);
      expect(adopted.status).toBe('adopted');
      if (adopted.status !== 'adopted') {
        throw new Error('unreachable');
      }
      kb.invalidateTextSnapshot('generated-community-projection');
      kb.publishGeneratedCommunityProjection({
        snapshot: currentSnapshot,
        generatedCommunityGeneration: adopted.generation,
        generatedCommunityDocsHash: adopted.generatedCommunityDocsHash,
      });
    });

    const staleResult = await commitCorpusProjection(kb, staged);
    expect(staleResult).toMatchObject({ status: 'discarded', reason: 'stale_generated_generation' });
    expect(kb.readIndex()).toBeNull();
    expect(kb.readIndexState().textStaleReason).toBe('generated-community-projection');

    const retryCandidate = await deriveCorpusProjection(kb, captureIndexStateSnapshot(kb.readIndexState()));
    const retry = await commitCorpusProjection(kb, stageCorpusProjectionArtifacts(kb, retryCandidate));
    expect(retry.status).toBe('committed');
    expect(kb.readIndex()?.generatedCommunityGeneration).toBe(1);
    expect(kb.readIndexState().textStaleReason).toBeUndefined();
  });

  it('keeps corpus-scale rebuild work outside the mutation lock and commits only bounded adoption work', async () => {
    const { performRescan } = await loadLifecycleModule();
    const { kb, root } = createHarness();
    writeNote(root, 'projection-note', 'Initial body.');
    const originalLock = kb.withMutationLock.bind(kb);
    vi.spyOn(kb, 'withMutationLock').mockImplementation(async (fn, options) =>
      originalLock(async (mutation, args) => {
        scanGate.insideMutationLock = true;
        try {
          return await fn(mutation, args);
        } finally {
          scanGate.insideMutationLock = false;
        }
      }, options),
    );
    const originalStage = kb.stageCorpusProjectionArtifacts.bind(kb);
    vi.spyOn(kb, 'stageCorpusProjectionArtifacts').mockImplementation((candidate) => {
      scanGate.assertUnlocked('full index serialization and projection staging');
      return originalStage(candidate);
    });
    const originalBaselineStage = kb.corpusAuthorityBaseline.stageReplacement.bind(kb.corpusAuthorityBaseline);
    vi.spyOn(kb.corpusAuthorityBaseline, 'stageReplacement').mockImplementation((records, generationId) => {
      scanGate.assertUnlocked('full authority baseline replacement');
      return originalBaselineStage(records, generationId);
    });
    const originalBaselineReplace = kb.corpusAuthorityBaseline.replace.bind(kb.corpusAuthorityBaseline);
    vi.spyOn(kb.corpusAuthorityBaseline, 'replace').mockImplementation((records) => {
      scanGate.assertUnlocked('full authority baseline replace');
      return originalBaselineReplace(records);
    });

    await expect(performRescan(kb, captureIndexStateSnapshot(kb.readIndexState()))).resolves.toMatchObject({
      status: 'committed',
    });
    expect(scanGate.forbiddenLockWork).toEqual([]);
  });

  it.each(CORPUS_PROJECTION_FAULT_PHASES)(
    'reconciles an interrupted corpus projection commit after %s',
    async (phase) => {
      const { deriveCorpusProjection, stageCorpusProjectionArtifacts, commitCorpusProjection } =
        await loadLifecycleModule();
      const harness = createHarness();
      writeNote(harness.root, 'projection-note', `Body for ${phase}.`);
      const generated = harness.kb.generatedCommunityProjectionStore.stageGeneration({
        snapshot: harness.kb.captureCorpusSnapshot(),
        topologyHash: 'topology-crash',
        documents: [
          generatedCommunityDocument(
            [
              '---',
              'coralGeneratedCommunity: true',
              'createdAt: 2026-06-01',
              'updatedAt: 2026-06-01',
              'level: 1',
              '---',
              '# Generated G2',
              '',
              '## Members',
              '- #fresh',
              '',
              `Generated community survives ${phase}.`,
              '',
            ].join('\n'),
          ),
        ],
      });
      const generatedAdopt = harness.kb.generatedCommunityProjectionStore.adoptStagedGeneration(
        generated,
        harness.kb.captureCorpusSnapshot(),
      );
      expect(generatedAdopt.status).toBe('adopted');

      const candidate = await deriveCorpusProjection(
        harness.kb,
        captureIndexStateSnapshot(harness.kb.readIndexState()),
      );
      const previousSeq = captureIndexStateSnapshot(harness.kb.readIndexState());
      const previousBaselineGenerationId = harness.kb.corpusAuthorityBaseline.readActiveGenerationId();
      const previousManifestCommitId = manifestCommitId(harness.kb);
      const expectedNextState = projectedNextState(harness.kb, candidate.externalMutation ?? null);
      const staged = stageCorpusProjectionArtifacts(harness.kb, candidate);
      await expect(
        commitCorpusProjection(harness.kb, staged, {
          faultInjection: { failAfterPhase: phase },
        }),
      ).rejects.toThrow(/Injected corpus projection commit fault/);

      const reopened = reopenHarness(harness);
      harness.db = reopened.db;
      harness.kb = reopened.kb;
      const committed = phase === 'state_persisted' || phase === 'state_written' || phase === 'committed';
      expect(harness.kb.generatedCommunityProjectionStore.readActiveFreshness()).toEqual({
        generatedCommunityGeneration: 1,
        generatedCommunityDocsHash: generated.generationDocsHash,
      });
      expect(harness.kb.generatedCommunityProjectionStore.readCommunityDocument('generated-g2')).not.toBeNull();
      expect(existsSync(staged.stagedIndex.stagingDir)).toBe(false);
      expect(existsSync(join(harness.runtimeDir, 'corpus-projection', 'commits', staged.commitId))).toBe(false);
      if (committed) {
        expect(harness.kb.readIndex()?.entries[noteEntryId('projection-note')]).toBeDefined();
        expect(harness.kb.readIndex()?.generatedCommunityGeneration).toBe(1);
        expect(harness.kb.corpusAuthorityBaseline.readActiveGenerationId()).toBe(staged.stagedBaseline.generationId);
        expect(manifestCommitId(harness.kb)).toBe(staged.commitId);
        expect(captureIndexStateSnapshot(harness.kb.readIndexState())).toEqual(
          captureIndexStateSnapshot(expectedNextState),
        );
        expect(harness.kb.readIndexState().textStaleReason).toBeUndefined();
        return;
      }

      expect(harness.kb.readIndex()).toBeNull();
      expect(harness.kb.corpusAuthorityBaseline.readActiveGenerationId()).toBe(previousBaselineGenerationId);
      expect(harness.kb.corpusAuthorityBaseline.read().size).toBe(0);
      expect(manifestCommitId(harness.kb)).toBe(previousManifestCommitId);
      expect(captureIndexStateSnapshot(harness.kb.readIndexState())).toEqual(previousSeq);
    },
  );

  it('keeps another staged candidate intact when a later staging attempt fails', async () => {
    const { deriveCorpusProjection, stageCorpusProjectionArtifacts, commitCorpusProjection } =
      await loadLifecycleModule();
    const { kb, root } = createHarness();
    writeNote(root, 'projection-note', 'Shared staging root must survive.');
    const candidate = await deriveCorpusProjection(kb, captureIndexStateSnapshot(kb.readIndexState()));
    const firstStaged = stageCorpusProjectionArtifacts(kb, candidate);
    const manifestAuthority = (
      kb as unknown as {
        manifestAuthority: { stageCurrentSurfaceHashes: (...args: unknown[]) => unknown };
      }
    ).manifestAuthority;
    vi.spyOn(manifestAuthority, 'stageCurrentSurfaceHashes').mockImplementationOnce(() => {
      throw new Error('injected manifest staging failure');
    });

    expect(() => stageCorpusProjectionArtifacts(kb, candidate)).toThrow('injected manifest staging failure');
    expect(existsSync(firstStaged.stagedIndex.stagingDir)).toBe(true);
    expect(existsSync(firstStaged.stagedIndex.indexPath)).toBe(true);

    await expect(commitCorpusProjection(kb, firstStaged)).resolves.toMatchObject({ status: 'committed' });
    expect(kb.readIndex()?.entries[noteEntryId('projection-note')]).toBeDefined();
  });

  it('restores the previous index after a crash between index rename and index_adopted record write', async () => {
    const { performRescan, deriveCorpusProjection, stageCorpusProjectionArtifacts, commitCorpusProjection } =
      await loadLifecycleModule();
    const harness = createHarness();
    writeNote(harness.root, 'projection-note', 'Old index body.');
    await expect(
      performRescan(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState())),
    ).resolves.toMatchObject({ status: 'committed' });
    const previousEntry = harness.kb.readIndex()?.entries[noteEntryId('projection-note')];
    expect(previousEntry).toBeDefined();
    const previousBaselineGenerationId = harness.kb.corpusAuthorityBaseline.readActiveGenerationId();
    const previousManifestCommitId = manifestCommitId(harness.kb);

    writeNote(harness.root, 'projection-note', 'New index body that must not survive rollback.');
    harness.kb.invalidateTextSnapshot('external edit pending projection');
    const previousSeq = captureIndexStateSnapshot(harness.kb.readIndexState());
    const previousTextStaleReason = harness.kb.readIndexState().textStaleReason;
    const candidate = await deriveCorpusProjection(harness.kb, captureIndexStateSnapshot(harness.kb.readIndexState()));
    const staged = stageCorpusProjectionArtifacts(harness.kb, candidate);
    expect(staged.candidate.index.entries[noteEntryId('projection-note')]).not.toEqual(previousEntry);

    await expect(
      commitCorpusProjection(harness.kb, staged, {
        faultInjection: { failAfterPhase: 'index_renamed' },
      }),
    ).rejects.toThrow(/Injected corpus projection commit fault/);

    const reopened = reopenHarness(harness);
    harness.db = reopened.db;
    harness.kb = reopened.kb;

    expect(harness.kb.readIndex()?.entries[noteEntryId('projection-note')]).toEqual(previousEntry);
    expect(harness.kb.corpusAuthorityBaseline.readActiveGenerationId()).toBe(previousBaselineGenerationId);
    expect(manifestCommitId(harness.kb)).toBe(previousManifestCommitId);
    expect(captureIndexStateSnapshot(harness.kb.readIndexState())).toEqual(previousSeq);
    expect(harness.kb.readIndexState().textStaleReason).toBe(previousTextStaleReason);
    expect(existsSync(join(harness.runtimeDir, 'corpus-projection', 'commits', staged.commitId))).toBe(false);
  });
});
