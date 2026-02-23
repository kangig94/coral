import type { AgentState, TranscriptEntry } from './types.js';

const SOFT_LIMIT = 80;
const HARD_LIMIT = 100;

const SENTENCE_END = /[.!?]$/u;

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
    const flush = () => {
      if (current) {
        lines.push(current);
        current = '';
      }
    };

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= soft) {
        current = candidate;
      } else if (candidate.length <= hard) {
        if (SENTENCE_END.test(current.trimEnd())) {
          flush();
          current = word;
        } else {
          current = candidate;
        }
      } else {
        flush();
        current = word;
      }
    }
    flush();
  }

  return lines.join('\n');
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

export function generateOneLiner(content: string): string {
  const flat = content.replace(/\n/g, ' ').trim();
  const sentenceEnd = flat.search(/[.!?]\s/u);
  if (sentenceEnd !== -1 && sentenceEnd < 120) return flat.slice(0, sentenceEnd + 1);
  if (flat.length <= 100) return flat;
  const cut = flat.lastIndexOf(' ', 100);
  return cut > 0 ? flat.slice(0, cut) + '…' : flat.slice(0, 100) + '…';
}

function summarizeSpeech(agentName: string, content: string): string {
  return `- ${agentName}: ${generateOneLiner(content)}`;
}

function renderBidRows(
  bids: Record<string, number>,
  agents: Record<string, AgentState>,
  effectiveBids?: Record<string, number>,
): string {
  const hasEffectiveBids = effectiveBids !== undefined;
  const effectiveBidMap = effectiveBids ?? {};
  const rows = Object.entries(bids)
    .sort(([lhsName, lhsRaw], [rhsName, rhsRaw]) => {
      const lhs = (effectiveBids?.[lhsName] ?? lhsRaw);
      const rhs = (effectiveBids?.[rhsName] ?? rhsRaw);
      return rhs - lhs;
    })
    .map(([name, score]) => {
      const displayName = agents[name]?.display_name ?? name;
      const quota = agents[name]?.quota_remaining ?? '?';
      if (!hasEffectiveBids) {
        return `| ${displayName} (${name}) | ${score} | ${quota} |`;
      }
      const effective = effectiveBidMap[name] ?? score;
      const effectiveText = Number.isInteger(effective) ? String(effective) : effective.toFixed(1);
      return `| ${displayName} (${name}) | ${score} | ${effectiveText} | ${quota} |`;
    });

  return rows.join('\n');
}

export function renderEntries(
  entries: TranscriptEntry[],
  agents: Record<string, AgentState>,
): string {
  return entries.map((e) => renderEntry(e, agents)).join('');
}

export function renderEntry(e: TranscriptEntry, agents: Record<string, AgentState>): string {
  switch (e.type) {
    case 'bids': {
      const effectiveBids = e.effective_bids;
      const winnerLine = e.winner
        ? `> **Winner: ${agents[e.winner]?.display_name ?? e.winner}** (${e.resolve_type})`
        : `> **No winner** (${e.resolve_type})`;
      const rows = renderBidRows(e.bids, agents, effectiveBids);
      const header = effectiveBids
        ? `| Agent | Raw | Effective | Quota |\n|-------|-----|-----------|-------|`
        : `| Agent | Score | Quota |\n|-------|-------|-------|`;
      return `\n#### Bids - Step ${e.step}\n${header}\n${rows}\n${winnerLine}\n\n---\n`;
    }
    case 'speech': {
      const ts = formatTimestamp(e.ts);
      const wrapped = wrapText(e.content);
      return `\n### ${ts} ${e.display_name} (${e.agent})\n${wrapped}\n`;
    }
    case 'epoch_summary': {
      const ts = formatTimestamp(e.ts);
      const wrapped = wrapText(e.summary);
      return `\n## Epoch ${e.epoch}\n\n### ${ts} Epoch Summary (by Moderator)\n${wrapped}\n`;
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

export function renderHeader(topic: string): string {
  return `# ${topic}\n\n## Epoch 1\n`;
}

/**
 * Agent-facing full transcript: bids entries filtered to speaker name only (information veil).
 * Agents cannot infer bid scores, quota state, or resolution mechanism from this view.
 * Full audit data (scores, quotas) is preserved in transcript.md for human review.
 */
export function formatFull(entries: TranscriptEntry[], agents: Record<string, AgentState>): string {
  const agentView = entries.map((entry) => {
    if (entry.type !== 'bids') return renderEntry(entry, agents);
    if (!entry.winner) return '';
    const winnerDisplayName = agents[entry.winner]?.display_name ?? entry.winner;
    return `\n> **Speaker: ${winnerDisplayName}**\n`;
  }).join('');
  return renderHeader('') + agentView;
}

export function formatRecent(
  entries: TranscriptEntry[],
  lastN: number,
  agents: Record<string, AgentState>,
): string {
  const speeches = entries.filter(
    (e): e is Extract<TranscriptEntry, { type: 'speech' }> => e.type === 'speech',
  );
  const recentStart = Math.max(0, speeches.length - lastN);

  const olderSummaries = speeches.slice(0, recentStart)
    .map((speech) => summarizeSpeech(speech.display_name, speech.content));
  const recentParts = speeches.slice(recentStart).map((speech) => renderEntry(speech, agents));

  const parts: string[] = [];
  if (olderSummaries.length > 0) {
    parts.push('## Earlier speeches (summary)\n' + olderSummaries.join('\n'));
  }
  if (recentParts.length > 0) {
    parts.push('## Recent\n' + recentParts.join(''));
  }
  return parts.join('\n\n');
}

export function formatSummary(
  entries: TranscriptEntry[],
  _agents: Record<string, AgentState>,
): string {
  return entries
    .filter((e): e is Extract<TranscriptEntry, { type: 'speech' }> => e.type === 'speech')
    .map((e) => summarizeSpeech(e.display_name, e.content))
    .join('\n');
}
