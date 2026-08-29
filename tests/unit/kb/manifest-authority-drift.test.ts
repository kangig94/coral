import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KbRuntime } from '#src/kb/contract.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { deleteNote } from '#src/kb/ops/delete.js';
import { update } from '#src/kb/ops/update.js';
import { persistPreparedSource } from '#src/kb/ops/source/store.js';
import { promote } from '#src/kb/ops/promote.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import type { EntityGraph } from '#src/kb/entry-types.js';
import { memoDir } from '#src/kb/paths.js';
import { commitMetadataTargets } from '#src/kb/curate/metadata-commit.js';
import { runPrincipleDiscovery } from '#src/kb/curate/principles.js';
import { runCommunitySubphase } from '#src/kb/curate/community/index.js';
import {
  cursorTimestampFromStorageSeq,
  noteCursor,
  readCurateState,
  writeCurateState,
} from '#src/kb/curate/state/index.js';
import { computeCorpusSurfaceManifestHash } from '#src/kb/corpus/surface.js';
import { applyDetectedIncidentFixesLocked } from '#src/kb/corpus/rescan/auto-fix.js';
import { createGitSyncController } from '#src/kb/curate/git-sync.js';
import {
  REPAIR_INCIDENT_ID,
  repairIncidentLocus,
  type DetectedIncident,
} from '#src/kb/corpus/rescan/incidents/catalog.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { curateDb } from '../../../src/kb/curate/db-access.js';

const tempRoots: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

function renderNote({
  title,
  tags,
  principles = [],
  body,
  entrySeq,
  related = [],
  updatedAt,
}: {
  title: string;
  tags: string[];
  principles?: string[];
  body: string;
  entrySeq: number;
  related?: string[];
  updatedAt?: string;
}): string {
  return [
    '---',
    `tags: [${tags.join(', ')}]`,
    `principles: [${principles.join(', ')}]`,
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-04-01T00:00:00.000Z',
    `updatedAt: ${updatedAt ?? '2026-04-01T00:00:00.000Z'}`,
    `entrySeq: ${entrySeq}`,
    ...(related.length === 0 ? [] : ['related:', ...related.map((entry) => `  - "${entry}"`)]),
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderSource({
  title,
  tags,
  body,
  entrySeq,
}: {
  title: string;
  tags: string[];
  body: string;
  entrySeq: number;
}): string {
  return [
    '---',
    `title: ${title}`,
    'type: article',
    `tags: [${tags.join(', ')}]`,
    'importedAt: 2026-04-01',
    `entrySeq: ${entrySeq}`,
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
}

function renderMemo(): string {
  return ['---', 'source: kangig94/coral', '---', 'memo body', ''].join('\n');
}

function renderMalformedEntrySeqNote(): string {
  return [
    '---',
    'tags: [repair]',
    'principles: []',
    'source:',
    '  - kangig94/coral',
    'createdAt: 2026-04-01T00:00:00.000Z',
    'updatedAt: 2026-04-01T00:00:00.000Z',
    'entrySeq: "31"',
    '---',
    '# Repair Target',
    '',
    'Repair me.',
    '',
  ].join('\n');
}

function writeRootNote(root: string, slug: string, raw: string): void {
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes', `${slug}.md`), raw, 'utf-8');
}

async function createRuntimeFixture(
  seed: (root: string) => void,
  options: { reindexOnBoot?: boolean } = {},
): Promise<{ root: string; kb: KbRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'coral-manifest-drift-'));
  tempRoots.push(root);
  seed(root);

  const db = openKbTestStoreDb(':memory:');
  const { kb } = createKbTestRuntime({
    markdownRoot: root,
    runtimeDir: root,
    db,
  });
  openDatabases.push(db);

  if (options.reindexOnBoot !== false) {
    await reindex(kb);
  }

  return { root, kb };
}

function setProcessedThrough(kb: KbRuntime, slug: string, entrySeq: number): void {
  const state = readCurateState(curateDb(kb));
  writeCurateState(curateDb(kb), {
    ...state,
    initialized: true,
    processedThrough: noteCursor(slug, cursorTimestampFromStorageSeq(entrySeq)),
  });
}

function assertAuthorityMatchesDisk(kb: KbRuntime): void {
  const snapshot = kb.captureCorpusSnapshot();
  expect(snapshot.contentManifestHash).toBe(computeCorpusSurfaceManifestHash(kb, 'content'));
  expect(snapshot.metadataManifestHash).toBe(computeCorpusSurfaceManifestHash(kb, 'metadata'));
}

function discoverySpawn(stdout: string): CurateAssistantPort {
  return {
    complete: async () => stdout,
  };
}

afterEach(() => {
  for (const db of openDatabases.splice(0).reverse()) {
    try {
      db.close();
    } catch {
      // ignore cleanup races
    }
  }

  for (const root of tempRoots.splice(0).reverse()) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('manifest authority drift checks', () => {
  it.each([
    {
      name: 'runInboundSync',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(
            root,
            'coral-alpha',
            renderNote({
              title: 'Alpha',
              tags: ['coral'],
              body: 'Original body.',
              entrySeq: 1,
            }),
          );
        });

        await fixture.kb.runInboundSync(
          async () => {
            writeFileSync(
              fixture.kb.notePath('coral-alpha'),
              renderNote({
                title: 'Alpha',
                tags: ['coral'],
                body: 'Inbound sync body.',
                entrySeq: 1,
              }),
              'utf-8',
            );
            return {
              kind: 'paths' as const,
              changes: [{ status: 'modified' as const, path: 'notes/coral-alpha.md' }],
            };
          },
          { structuredDiff: true },
        );

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'writeEntityGraph',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(
            root,
            'coral-graph-rag',
            renderNote({
              title: 'Graph RAG',
              tags: ['graph-rag', 'retrieval'],
              body: 'Graph-backed retrieval.',
              entrySeq: 1,
            }),
          );
        });

        const graph: EntityGraph = {
          entityMeta: {
            'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
            retrieval: { type: 'operation', description: 'Retrieval workflows.' },
          },
          relationships: [
            {
              source: 'graph-rag',
              target: 'retrieval',
              type: 'enables',
              description: 'Graph-backed retrieval improves recall.',
              evidence: ['note:coral-graph-rag'],
            },
          ],
        };

        await fixture.kb.withMutationLock((mutation) => {
          mutation.writeEntityGraph(graph);
        });

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'commitMetadataTargets',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(
            root,
            'coral-alpha',
            renderNote({
              title: 'Alpha',
              tags: ['coral'],
              body: 'Metadata target body.',
              entrySeq: 1,
            }),
          );
        });
        const note = fixture.kb.readIndexOrEmpty().entries['note:coral-alpha'];
        if (note === undefined || note.kind !== 'note' || note.entrySeq === undefined) {
          throw new Error('Expected seeded note entry.');
        }

        await commitMetadataTargets(fixture.kb, [
          {
            kind: 'note',
            entryId: 'note:coral-alpha',
            slug: 'coral-alpha',
            entrySeq: note.entrySeq,
            cursor: noteCursor('coral-alpha', cursorTimestampFromStorageSeq(note.entrySeq)),
            claimTimeUpdatedAt: note.updatedAt,
            addTags: ['drift'],
          },
        ]);

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'runPrincipleDiscovery',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(
            root,
            'coral-discovery-01',
            renderNote({ title: 'One', tags: ['coral'], body: 'Shared principle A.', entrySeq: 1 }),
          );
          writeRootNote(
            root,
            'coral-discovery-02',
            renderNote({ title: 'Two', tags: ['coral'], body: 'Shared principle B.', entrySeq: 2 }),
          );
          writeRootNote(
            root,
            'coral-discovery-03',
            renderNote({ title: 'Three', tags: ['coral'], body: 'Shared principle C.', entrySeq: 3 }),
          );
        });
        setProcessedThrough(fixture.kb, 'coral-discovery-03', 3);

        await runPrincipleDiscovery(
          fixture.kb,
          discoverySpawn(
            JSON.stringify([
              {
                slug: 'deterministic-ordering',
                statement: 'Prefer deterministic ordering when multiple valid outputs exist.',
                notes: ['coral-discovery-01', 'coral-discovery-02', 'coral-discovery-03'],
              },
            ]),
          ),
          {
            ...noteCursor('coral-discovery-03', cursorTimestampFromStorageSeq(3)),
          },
        );

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'runCommunitySubphase',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(
            root,
            'coral-graph-rag',
            renderNote({
              title: 'Graph RAG',
              tags: ['graph-rag', 'retrieval'],
              body: 'Graph-backed retrieval.',
              entrySeq: 1,
            }),
          );
        });

        await fixture.kb.writeEntityGraph({
          entityMeta: {
            'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
            retrieval: { type: 'operation', description: 'Retrieval workflows.' },
          },
          relationships: [
            {
              source: 'graph-rag',
              target: 'retrieval',
              type: 'enables',
              description: 'Graph-backed retrieval improves recall.',
              evidence: ['note:coral-graph-rag'],
            },
          ],
        });

        await runCommunitySubphase(fixture.kb);

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'update',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(
            root,
            'coral-alpha',
            renderNote({
              title: 'Alpha',
              tags: ['coral'],
              body: 'Original update body.',
              entrySeq: 1,
            }),
          );
        });

        await update(fixture.kb, {
          note: 'coral-alpha',
          content: 'Updated body.',
        });

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'delete',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(
            root,
            'coral-delete',
            renderNote({
              title: 'Delete',
              tags: ['coral'],
              body: 'Delete me.',
              entrySeq: 1,
            }),
          );
        });

        await deleteNote(fixture.kb, { note: 'coral-delete' });

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'promote',
      run: async () => {
        const fixture = await createRuntimeFixture(() => {}, { reindexOnBoot: false });
        // `memoDir` and `promote` take the resolved per-project DATA dir. In production
        // the shell passes `runtime.paths.projectData(projectRoot)`; here a tmp dir under
        // fixture.root stands in directly, which keeps the memo read/write isolated.
        const projectDataDir = mkdtempSync(join(fixture.root, 'local-project-'));
        const projectMemoDir = memoDir(projectDataDir);
        mkdirSync(projectMemoDir, { recursive: true });
        writeFileSync(join(projectMemoDir, 'promotion.md'), renderMemo(), 'utf-8');

        await promote(fixture.kb, projectDataDir, {
          memo: 'promotion.md',
          title: 'Promotion',
          content: 'Promoted content.',
          domain: 'coral',
          topic: 'promotion',
        });

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'persistPreparedSource',
      run: async () => {
        const fixture = await createRuntimeFixture(() => {}, { reindexOnBoot: false });
        mkdirSync(fixture.kb.sourceImportStageDir(), { recursive: true });
        const stagedPath = join(fixture.kb.sourceImportStageDir(), 'prepared.md');
        writeFileSync(
          stagedPath,
          renderSource({
            title: 'Prepared Source',
            tags: ['database'],
            body: 'Prepared source body.',
            entrySeq: 1,
          }),
          'utf-8',
        );

        await persistPreparedSource(fixture.kb, stagedPath, 'prepared-source');

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'applyDetectedIncidentFixesLocked',
      run: async () => {
        const fixture = await createRuntimeFixture(
          (root) => {
            writeRootNote(root, 'repair-target', renderMalformedEntrySeqNote());
          },
          { reindexOnBoot: false },
        );

        const runtime = createRealRuntime('prod');
        const gitSync = createGitSyncController({
          kb: fixture.kb,
          curateAssistant: discoverySpawn(''),
          processPort: runtime.process,
          storagePort: runtime.storage,
          envPort: runtime.env,
        });
        await fixture.kb.withMutationLock((mutation) =>
          applyDetectedIncidentFixesLocked(fixture.kb, mutation, gitSync, [
            {
              locus: repairIncidentLocus(REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT),
              canonical: REPAIR_INCIDENT_ID.IDENTITY_SEQUENCE.ENTRYSEQ_FORMAT,
              entryId: 'note:repair-target',
              signals: {
                reasons: ['quoted-decimal'],
                quotedDecimal: 'entrySeq: "31"',
                parsedType: 'string',
                normalizedValue: 31,
              },
            } as DetectedIncident,
          ]),
        );

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
  ])('$name keeps manifest authority aligned with disk truth', async ({ run }) => {
    await run();
  });
});
