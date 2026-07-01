import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { CURATE_COMMUNITY_SUMMARY_AGENT_MODEL } from '#src/kb/curate/assistant.js';
import { runCommunitySummaryAgent } from '#src/kb/curate/community/summary-agent.js';
import { runCommunitySubphase } from '#src/kb/curate/community/index.js';
import { listStaleCommunities } from '#src/kb/curate/community/summary-surface.js';
import { writeCurateState, type CurateState } from '#src/kb/curate/state/index.js';
import { curateDb } from '#src/kb/curate/db-access.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createKbTestRuntime } from '#tests/helpers/kb-test-runtime.js';
import { bindOramaFtsForTest } from '#tests/unit/kb/expansion-test-helpers.js';
import { computeBodySurfaceHash } from '#src/kb/corpus/snapshot.js';
import { createRealRuntime } from '#src/runtime/real.js';
import type { EntityGraph } from '#src/kb/entry-types.js';

const CREATED_AT = '2026-06-19T00:00:00.000Z';

function freshCurateState(): CurateState {
  return {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    activeClaim: null,
    pendingDiscoveries: [],
    communitySummaryTopologyHash: undefined,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    claimLaneDisabledAt: null,
    communityBatchLaneDisabledAt: null,
    initialized: true,
  };
}

describe('runCommunitySummaryAgent', () => {
  let tempDir: string;
  let runtime: KbRuntime;
  let gitSyncRuntime: ReturnType<typeof createRealRuntime>;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-summary-agent-'));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'claude-config');
    gitSyncRuntime = createRealRuntime('prod');
    const db = createKbTestDb(tempDir);
    ({ kb: runtime } = createKbTestRuntime({
      markdownRoot: tempDir,
      runtimeDir: tempDir,
      db,
      runtime: gitSyncRuntime,
      curateAssistant: { complete: async () => '' },
    }));
    bindOramaFtsForTest(runtime);

    // Materialize one community (topology-only, so it is stale: no summary).
    mkdirSync(runtime.notesDir(), { recursive: true });
    writeFileSync(
      join(runtime.notesDir(), 'coral-peer.md'),
      [
        '---',
        'tags: [graph-rag, retrieval]',
        'principles: []',
        'source:',
        '  - kangig94/coral',
        `createdAt: ${CREATED_AT}`,
        `updatedAt: ${CREATED_AT}`,
        'entrySeq: 1',
        '---',
        '# Peer',
        '',
        'Graph-backed retrieval improves context selection.',
      ].join('\n'),
      'utf-8',
    );
    const entityMeta: EntityGraph['entityMeta'] = {
      'graph-rag': { type: 'concept', description: 'Graph-backed retrieval.' },
      retrieval: { type: 'operation', description: 'Retrieval workflows.' },
    };
    const relationships: EntityGraph['relationships'] = [
      {
        source: 'graph-rag',
        target: 'retrieval',
        type: 'enables',
        description: 'Graph structure improves retrieval.',
        evidence: ['note:coral-peer'],
      },
    ];
    runtime.writeIndex({
      entries: {
        'note:coral-peer': {
          kind: 'note',
          slug: 'coral-peer',
          title: 'Peer',
          tags: ['graph-rag', 'retrieval'],
          principles: [],
          source: ['kangig94/coral'],
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          bodyHash: computeBodySurfaceHash('Graph-backed retrieval improves context selection.'),
          entrySeq: 1,
        },
      },
      principles: {},
      entityMeta,
      relationships,
    });
    await runtime.writeEntityGraph({ entityMeta, relationships });
    writeCurateState(curateDb(runtime), freshCurateState());
    await runCommunitySubphase(runtime);
  });

  afterEach(() => {
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('spawns no turn when the stale work-list is empty', async () => {
    // Drop the entity graph and republish the generated projection so no
    // communities are detected/stale.
    runtime.writeIndex({
      ...runtime.readIndexOrEmpty(),
      entityMeta: {},
      relationships: [],
    });
    await runtime.writeEntityGraph({ entityMeta: {}, relationships: [] });
    await runCommunitySubphase(runtime);
    rmSync(runtime.communitiesDir(), { recursive: true, force: true });
    expect(listStaleCommunities(runtime)).toEqual([]);

    const complete = vi.fn<CurateAssistantPort['complete']>(async () => '');
    await expect(runCommunitySummaryAgent(runtime, { complete })).resolves.toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('runs exactly one turn with the approved prompt and 1M model when work exists', async () => {
    expect(listStaleCommunities(runtime).length).toBeGreaterThan(0);

    const complete = vi.fn<CurateAssistantPort['complete']>(async () => 'done');
    await expect(runCommunitySummaryAgent(runtime, { complete })).resolves.toBe(true);

    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0][0];
    expect(request.purpose).toBe('community-summary');
    expect(request.model).toBe(CURATE_COMMUNITY_SUMMARY_AGENT_MODEL);
    expect(request.permissionMode).toBe('auto');
    expect(request.prompt).toContain('coral-cli kb community list-stale');
    expect(request.prompt).toContain('coral-cli kb community summary-input <slug>');
    expect(request.prompt).toContain('coral-cli kb community set-summary <slug> --from');
    expect(request.prompt).toContain('Never invent or pass a fingerprint');
  });

  it('propagates the abort signal into the agent turn', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const complete = vi.fn<CurateAssistantPort['complete']>(async (request) => {
      observedSignal = request.signal;
      controller.abort();
      throw new Error('aborted');
    });

    await expect(runCommunitySummaryAgent(runtime, { complete }, controller.signal)).rejects.toThrow('aborted');
    expect(observedSignal).toBe(controller.signal);
    expect(observedSignal?.aborted).toBe(true);
  });
});
