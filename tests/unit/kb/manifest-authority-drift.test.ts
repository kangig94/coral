import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KbRuntime } from '#src/kb/contracts.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { deleteFn } from '#src/kb/ops/delete.js';
import { update } from '#src/kb/ops/update.js';
import { persistPreparedSource } from '#src/kb/ops/source-store.js';
import { promote } from '#src/kb/ops/promote.js';
import { reindex } from '#src/kb/ops/reindex.js';
import { createKbRuntime } from '#src/kb/runtime.js';
import { noteEntryId, type EntityGraph } from '#src/kb/entry-types.js';
import { memoDir } from '#src/kb/paths.js';
import { commitMetadataTargets } from '#src/kb/curate/metadata-commit.js';
import { runPrincipleDiscovery } from '#src/kb/curate/principles.js';
import { runCommunitySubphase } from '#src/kb/curate/community.js';
import { generateCommunityFiles, renderCommunityDocument } from '#src/kb/curate/community-detection.js';
import { readCurateState, writeCurateState } from '#src/kb/curate/state.js';
import { recordMetadataMutation } from '#src/kb/corpus/index-mutations.js';
import { computeFullCollectorManifestHash } from '#src/kb/corpus/manifest-authority.js';
import { applyDetectedIncidentFixes } from '#src/kb/corpus/repair/fix.js';
import { REPAIR_INCIDENT_ID, repairIncidentLocus } from '#src/kb/corpus/repair/incident-ids.js';
import type { DetectedIncident } from '#src/kb/corpus/repair/corpus-scan.js';
import type { SpawnCliFn } from '#src/kb/curate/types.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';

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

  const kb = createKbRuntime({
    markdownRoot: root,
    runtimeDir: root,
    db: createKbTestDb(root),
  });
  openDatabases.push(kb.db);

  if (options.reindexOnBoot !== false) {
    await reindex(kb);
  }

  return { root, kb };
}

function setProcessedThrough(kb: KbRuntime, slug: string, entrySeq: number): void {
  const state = readCurateState(kb);
  writeCurateState(kb, {
    ...state,
    initialized: true,
    processedThrough: {
      entryId: noteEntryId(slug),
      entrySeq,
    },
  });
}

function assertAuthorityMatchesDisk(kb: KbRuntime): void {
  const snapshot = kb.captureCorpusSnapshot();
  expect(snapshot.contentManifestHash).toBe(computeFullCollectorManifestHash(kb, 'content'));
  expect(snapshot.metadataManifestHash).toBe(computeFullCollectorManifestHash(kb, 'metadata'));
}

function discoverySpawn(stdout: string): SpawnCliFn {
  return async () => ({
    stdout,
    stderr: '',
    code: 0,
    aborted: false,
  });
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

describe('manifest authority drift checks (AC2)', () => {
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
          writeRootNote(root, 'coral-discovery-01', renderNote({ title: 'One', tags: ['coral'], body: 'Shared principle A.', entrySeq: 1 }));
          writeRootNote(root, 'coral-discovery-02', renderNote({ title: 'Two', tags: ['coral'], body: 'Shared principle B.', entrySeq: 2 }));
          writeRootNote(root, 'coral-discovery-03', renderNote({ title: 'Three', tags: ['coral'], body: 'Shared principle C.', entrySeq: 3 }));
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
            entryId: noteEntryId('coral-discovery-03'),
            entrySeq: 3,
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

        await runCommunitySubphase(
          fixture.kb,
          discoverySpawn('Shared themes across graph-backed retrieval.'),
        );

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'generateCommunityFiles',
      run: async () => {
        const fixture = await createRuntimeFixture(() => {}, { reindexOnBoot: false });

        await fixture.kb.withMutationLock((mutation) => {
          generateCommunityFiles(
            fixture.kb,
            mutation,
            [
              {
                slug: 'retrieval-community',
                title: 'Retrieval Community',
                level: 1,
                members: ['graph-rag', 'retrieval'],
                createdAt: '2026-04-02',
                updatedAt: '2026-04-02',
                content: renderCommunityDocument({
                  title: 'Retrieval Community',
                  members: ['graph-rag', 'retrieval'],
                  level: 1,
                  summary: 'Shared retrieval themes.',
                  createdAt: '2026-04-02',
                  updatedAt: '2026-04-02',
                }),
              },
            ],
            [],
          );
          recordMetadataMutation(fixture.kb, 'KB text snapshot is stale after community generation.');
        });

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

        await deleteFn(fixture.kb, { note: 'coral-delete' });

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
    {
      name: 'promote',
      run: async () => {
        const fixture = await createRuntimeFixture(() => {}, { reindexOnBoot: false });
        const projectRoot = mkdtempSync(join(fixture.root, 'local-project-'));
        const projectMemoDir = memoDir(projectRoot);
        mkdirSync(projectMemoDir, { recursive: true });
        writeFileSync(join(projectMemoDir, 'promotion.md'), renderMemo(), 'utf-8');

        await promote(fixture.kb, projectRoot, {
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
      name: 'applyDetectedIncidentFixes',
      run: async () => {
        const fixture = await createRuntimeFixture((root) => {
          writeRootNote(root, 'repair-target', renderMalformedEntrySeqNote());
        }, { reindexOnBoot: false });

        const runtime = createRealRuntime('prod');
        await applyDetectedIncidentFixes(
          [
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
          ],
          fixture.kb,
          {
            processPort: runtime.process,
            storagePort: runtime.storage,
            envPort: runtime.env,
          },
        );

        assertAuthorityMatchesDisk(fixture.kb);
      },
    },
  ])('$name keeps manifest authority aligned with disk truth', async ({ run }) => {
    await run();
  });
});
