import { join } from 'node:path';

import type { StoragePort } from '../infra/port-types.js';
import type { PersistedDiscussSnapshot } from './events.js';
import type { DiscussState, TranscriptEntry } from './session-types.js';

/** Storage slice needed to materialize a discuss record into the project data dir. */
export type DiscussRecordStorage = Pick<StoragePort, 'mkdirSync' | 'writeAtomicSync'>;

const MAX_SLUG_LENGTH = 60;

function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'discussion';
}

/** `YYYYMMDD-HHMMSS` from an ISO timestamp; mirrors the memo filename convention. */
function fileTimestamp(iso: string): string {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  return match ? `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}` : 'unknown-time';
}

/**
 * Path of the completed-discussion record under the project data dir:
 * `<projectDataDir>/discuss/<YYYYMMDD-HHMMSS>-<topic-slug>.md`.
 */
export function discussRecordPath(projectDataDir: string, snapshot: PersistedDiscussSnapshot): string {
  const filename = `${fileTimestamp(snapshot.state.created_at)}-${slugifyTopic(snapshot.state.topic)}.md`;
  return join(projectDataDir, 'discuss', filename);
}

function renderParticipants(state: DiscussState): string {
  const lines = Object.values(state.agents).map((agent) => `- ${agent.display_name} (${agent.persona})`);
  return lines.length > 0 ? lines.join('\n') : '- _(none)_';
}

/** Render one transcript entry as markdown, or `null` to omit it from the human record. */
function renderEntry(entry: TranscriptEntry): string | null {
  switch (entry.type) {
    case 'speech':
      return `**${entry.display_name}**\n\n${entry.content.trim()}`;
    case 'follow_up':
      return `**${entry.agent}** — follow-up\n\n_Q:_ ${entry.question.trim()}\n\n_A:_ ${entry.answer.trim()}`;
    case 'epoch_summary':
      return `> _Epoch ${entry.epoch} summary:_ ${entry.summary.trim()}`;
    case 'session_event':
      // The synthesis is rendered in its own section; bidding audit lives in the journal.
      return entry.event === 'synthesis' ? null : `_${entry.event}: ${entry.detail.trim()}_`;
    case 'bids':
      return null;
    default:
      return null;
  }
}

function extractSynthesis(state: DiscussState): string | null {
  for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
    const entry = state.transcript[index];
    if (entry?.type === 'session_event' && entry.event === 'synthesis') {
      return entry.detail.trim();
    }
  }
  return null;
}

/**
 * Render a completed discuss session as a standalone markdown record: header,
 * participants, the full transcript (speeches, follow-ups, epoch summaries), and
 * the final synthesis. Pure projection of the discuss journal stream — the
 * authoritative events stay in the store; this is a rebuildable export.
 */
export function renderDiscussRecordMarkdown(snapshot: PersistedDiscussSnapshot): string {
  const { state } = snapshot;
  const entries = state.transcript.map(renderEntry).filter((line): line is string => line !== null);
  const synthesis = extractSynthesis(state);

  return [
    `# Discussion: ${state.topic}`,
    '',
    `- Session: \`${snapshot.sessionId}\``,
    `- Started: ${state.created_at}`,
    `- Ended: ${snapshot.updatedAt}`,
    `- Epochs: ${state.epoch}/${state.max_epochs}`,
    '',
    '## Participants',
    '',
    renderParticipants(state),
    '',
    '## Transcript',
    '',
    entries.length > 0 ? entries.join('\n\n') : '_(no transcript entries)_',
    '',
    '## Final Synthesis',
    '',
    synthesis ?? '_(no synthesis recorded)_',
    '',
  ].join('\n');
}

/**
 * Write the completed-discussion record to the project data dir and return its
 * path. Best-effort export — callers isolate failures so a write error never
 * breaks the discussion itself; the authoritative record stays in the journal.
 */
export function writeDiscussRecord(
  deps: { storage: DiscussRecordStorage; projectData: (projectRoot: string) => string },
  snapshot: PersistedDiscussSnapshot,
): string {
  const projectDataDir = deps.projectData(snapshot.projectRoot);
  deps.storage.mkdirSync(join(projectDataDir, 'discuss'), { recursive: true });
  const path = discussRecordPath(projectDataDir, snapshot);
  if (!deps.storage.writeAtomicSync(path, renderDiscussRecordMarkdown(snapshot), { encoding: 'utf-8' })) {
    throw new Error(`Failed to write discuss record for ${snapshot.sessionId}`);
  }
  return path;
}
