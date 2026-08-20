import type { KbRuntime } from '../../contract.js';
import { CURATE_COMMUNITY_SUMMARY_AGENT_MODEL, type CurateAssistantPort } from '../assistant.js';
import { listStaleCommunities } from './summary-surface.js';

/**
 * The approved prompt for the community-summary agent. It drives one tool-using
 * Claude turn that loops the three `coral-cli kb community` commands until the
 * stale work-list is empty. Freshness authority stays server-side: the agent
 * never computes or passes a fingerprint — `set-summary` recomputes it.
 */
const COMMUNITY_SUMMARY_AGENT_PROMPT = `You are Coral's KB community-summary agent. Bring every stale community summary up to date, then stop. A community is a GraphRAG cluster of related KB entities; its summary is attached to search results as shared context, so it must be accurate, concise, and self-contained.

Loop until done:
1. Run: coral-cli kb community list-stale
   Lists communities whose summary is missing or stale, already ordered so any community you must summarize first (children before parents) comes first. If it prints "(none)", you are finished — report how many you summarized and STOP.
2. Take the FIRST listed slug, then:
   a. Run: coral-cli kb community summary-input <slug>
      This prints the material to summarize AND the instructions for how to write the summary. Follow those instructions exactly.
   b. Write your summary to a temp file (e.g. /tmp/coral-summary.txt). Plain text only.
   c. Run: coral-cli kb community set-summary <slug> --from /tmp/coral-summary.txt
3. Go back to step 1.

Rules:
- Re-run list-stale after every set-summary; never cache the list. It shrinks as you work and its order guarantees dependencies are summarized first.
- One community per iteration — always the first listed.
- Never invent or pass a fingerprint; set-summary computes freshness itself.
- Use only these coral-cli commands; do not edit KB files directly.
- If a command errors, report it and STOP.`;

/**
 * Run one community-summary agent turn when stale communities exist. Returns
 * `true` when an agent turn was spawned, `false` when the work-list was already
 * empty (a converged corpus — no token spend).
 */
export async function runCommunitySummaryAgent(
  kb: KbRuntime,
  curateAssistant: CurateAssistantPort,
  signal?: AbortSignal,
): Promise<boolean> {
  if (listStaleCommunities(kb).length === 0) {
    return false;
  }

  await curateAssistant.complete({
    prompt: COMMUNITY_SUMMARY_AGENT_PROMPT,
    purpose: 'community-summary',
    model: CURATE_COMMUNITY_SUMMARY_AGENT_MODEL,
    permissionMode: 'auto',
    ...(signal === undefined ? {} : { signal }),
  });

  return true;
}
