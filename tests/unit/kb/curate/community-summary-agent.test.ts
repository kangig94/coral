import { describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contract.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { CURATE_COMMUNITY_SUMMARY_AGENT_MODEL } from '#src/kb/curate/assistant.js';
import { runCommunitySummaryAgent } from '#src/kb/curate/community/summary-agent.js';

vi.mock('#src/kb/curate/community/summary-surface.js', () => ({
  listStaleCommunities: () => [{ slug: 'stale-community' }],
}));

describe('runCommunitySummaryAgent', () => {
  it('propagates the abort signal into the agent turn', async () => {
    const controller = new AbortController();
    const complete = vi.fn<CurateAssistantPort['complete']>(async (request) => {
      expect(request.signal).toBe(controller.signal);
      expect(request.purpose).toBe('community-summary');
      expect(request.model).toBe(CURATE_COMMUNITY_SUMMARY_AGENT_MODEL);
      expect(request.permissionMode).toBe('auto');
      controller.abort();
      throw new Error('aborted');
    });

    await expect(runCommunitySummaryAgent({} as KbRuntime, { complete }, controller.signal)).rejects.toThrow('aborted');
    expect(controller.signal.aborted).toBe(true);
  });
});
