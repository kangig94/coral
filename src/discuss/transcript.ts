/**
 * Transcript rendering — pure functions operating on structured TranscriptEntry[].
 * Human-readable format with timestamps and soft 80 / hard 100 word-wrap.
 *
 * Two rendering paths:
 * - renderEntries: full audit output for transcript.md (scores, quotas, all data)
 * - formatFull: agent-facing view (bids filtered to speaker name only — information veil)
 */

import type { AgentState, TranscriptEntry } from './types.js';

/** Soft and hard column limits for word-wrap. */
const SOFT_LIMIT = 80;
const HARD_LIMIT = 100;

/** Korean / CJK sentence-ending patterns for grace-zone detection. */
const SENTENCE_END = /[.!?]$|다\.$|요\.$|까\?$/u;

/**
 * Wrap text to soft 80 / hard 100 column limit.
 * - Target break at 80 chars (word boundary)
 * - Grace zone 80–100: extend to sentence end if available
 * - Hard limit 100: force break at word boundary
 */
export function wrapText(text: string, opts?: { soft?: number; hard?: number }): string {
  const soft = opts?.soft ?? SOFT_LIMIT;
  const hard = opts?.hard ?? HARD_LIMIT;
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }
    const words = paragraph.split(' ');
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= soft) {
        current = candidate;
      } else if (candidate.length <= hard) {
        if (SENTENCE_END.test(current.trimEnd())) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines.join('\n');
}

/** Format a Date as [HH:mm:ss] (short form for transcript headers). */
function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

/** Generate a one-line summary: first sentence or first ~100 chars at word boundary. */
export function generateOneLiner(content: string): string {
  const flat = content.replace(/\n/g, ' ').trim();
  const sentenceEnd = flat.search(/[.!?]\s/u);
  if (sentenceEnd !== -1 && sentenceEnd < 120) return flat.slice(0, sentenceEnd + 1);
  if (flat.length <= 100) return flat;
  const cut = flat.lastIndexOf(' ', 100);
  return cut > 0 ? flat.slice(0, cut) + '…' : flat.slice(0, 100) + '…';
}

// ─── Entry rendering ──────────────────────────────────────────────────────────

/** Render structured entries to markdown text. Used by SessionStore.save() for incremental append. */
export function renderEntries(
  entries: TranscriptEntry[],
  agents: Record<string, AgentState>,
): string {
  return entries.map((e) => renderEntry(e, agents)).join('');
}

export function renderEntry(e: TranscriptEntry, agents: Record<string, AgentState>): string {
  switch (e.type) {
    case 'bids': {
      const rows = Object.entries(e.bids)
        .sort(([, a], [, b]) => b - a)
        .map(([name, score]) => {
          const dn = agents[name]?.display_name ?? name;
          const q = agents[name]?.quota_remaining;
          return `| ${dn} (${name}) | ${score} | ${q ?? '?'} |`;
        })
        .join('\n');
      const winnerLine = e.winner
        ? `> **Winner: ${agents[e.winner]?.display_name ?? e.winner}** (${e.resolve_type})`
        : `> **No winner** (${e.resolve_type})`;
      return `\n#### Bids — Step ${e.step}\n| Agent | Score | Quota |\n|-------|-------|-------|\n${rows}\n${winnerLine}\n\n---\n`;
    }
    case 'speech': {
      const ts = formatTimestamp(e.ts);
      const wrapped = wrapText(e.content);
      return `\n### ${ts} ${e.display_name} (${e.agent})\n${wrapped}\n`;
    }
    case 'epoch_summary': {
      const ts = formatTimestamp(e.ts);
      const wrapped = wrapText(e.summary);
      return `\n## Epoch ${e.epoch}\n\n### ${ts} Epoch Summary (by Teamlead)\n${wrapped}\n`;
    }
    case 'session_event': {
      const ts = formatTimestamp(e.ts);
      if (e.event === 'synthesis') {
        const wrapped = wrapText(e.detail);
        return `\n## Synthesis\n\n### ${ts} Discussion Summary\n${wrapped}\n`;
      }
      return `\n### ${ts} [${e.event}]\n${e.detail}\n`;
    }
  }
}

/** Render topic header for initial transcript.md. */
export function renderHeader(topic: string): string {
  return `# ${topic}\n\n## Epoch 1\n`;
}

// ─── Transcript read functions (operate on structured entries) ────────────────

/**
 * Agent-facing full transcript: bids entries filtered to speaker name only (information veil).
 * Agents cannot infer bid scores, quota state, or resolution mechanism from this view.
 * Full audit data (scores, quotas) is preserved in transcript.md for human review.
 */
export function formatFull(entries: TranscriptEntry[], agents: Record<string, AgentState>): string {
  const agentView = entries.map((e) => {
    if (e.type === 'bids') {
      if (!e.winner) return '';  // no_winner rounds: skip (no speaker to announce)
      const dn = agents[e.winner]?.display_name ?? e.winner;
      return `\n> **Speaker: ${dn}**\n`;
    }
    return renderEntry(e, agents);
  }).join('');
  return renderHeader('') + agentView;
}

/**
 * Last N speech entries in full + earlier as one-line summaries.
 * Non-speech entries (bids, epoch summaries) are excluded.
 */
export function formatRecent(
  entries: TranscriptEntry[],
  lastN: number,
  agents: Record<string, AgentState>,
): string {
  const speeches = entries.filter(
    (e): e is Extract<TranscriptEntry, { type: 'speech' }> => e.type === 'speech',
  );
  const recentStart = Math.max(0, speeches.length - lastN);

  const olderSummaries: string[] = [];
  const recentParts: string[] = [];

  for (let i = 0; i < speeches.length; i++) {
    if (i >= recentStart) {
      recentParts.push(renderEntry(speeches[i], agents));
    } else {
      olderSummaries.push(`- ${speeches[i].display_name}: ${generateOneLiner(speeches[i].content)}`);
    }
  }

  const parts: string[] = [];
  if (olderSummaries.length > 0) {
    parts.push('## Earlier speeches (summary)\n' + olderSummaries.join('\n'));
  }
  if (recentParts.length > 0) {
    parts.push('## Recent\n' + recentParts.join(''));
  }
  return parts.join('\n\n');
}

/** Return all speech entries as one-line summaries. Non-speech entries are omitted. */
export function formatSummary(
  entries: TranscriptEntry[],
  agents: Record<string, AgentState>,
): string {
  return entries
    .filter((e): e is Extract<TranscriptEntry, { type: 'speech' }> => e.type === 'speech')
    .map((e) => `- ${e.display_name}: ${generateOneLiner(e.content)}`)
    .join('\n');
}
