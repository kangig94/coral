import type { AgentState, TranscriptEntry } from './session-types.js';

const pad2 = (n: number): string => String(n).padStart(2, '0');

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
  return `[${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}]`;
}

function renderBidRows(
  bids: Record<string, number>,
  agents: Record<string, AgentState>,
  effectiveBids?: Record<string, number>,
): string {
  const hasEffectiveBids = effectiveBids !== null && effectiveBids !== undefined;
  const rows = Object.entries(bids)
    .sort(([lhsName, lhsRaw], [rhsName, rhsRaw]) => {
      const lhs = effectiveBids?.[lhsName] ?? lhsRaw;
      const rhs = effectiveBids?.[rhsName] ?? rhsRaw;
      return rhs - lhs;
    })
    .map(([name, score]) => {
      const displayName = agents[name]?.display_name ?? name;
      const quota = agents[name]?.quota_remaining ?? '?';
      if (!hasEffectiveBids) {
        return `| ${displayName} (${name}) | ${score} | ${quota} |`;
      }
      const effective = effectiveBids?.[name] ?? score;
      const effectiveText = Number.isInteger(effective) ? String(effective) : effective.toFixed(1);
      return `| ${displayName} (${name}) | ${score} | ${effectiveText} | ${quota} |`;
    });

  return rows.join('\n');
}

export function renderEntries(entries: TranscriptEntry[], agents: Record<string, AgentState>): string {
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
    case 'follow_up': {
      const ts = formatTimestamp(e.ts);
      const agentLabel = agents[e.agent]?.display_name ?? e.agent;
      const wrappedQuestion = wrapText(e.question);
      const wrappedAnswer = wrapText(e.answer);
      return `\n### ${ts} Follow-up to ${agentLabel} (${e.agent})\nQ: ${wrappedQuestion}\nA: ${wrappedAnswer}\n`;
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

function renderPanelists(agents: Record<string, AgentState>): string {
  const sections: string[] = [];
  for (const agent of Object.values(agents)) {
    const downgraded = agent.persona.replace(/^### /gm, '##### ').replace(/^## /gm, '#### ').replace(/^# /gm, '### ');
    sections.push(wrapText(downgraded));
  }
  return '## Panelists\n\n' + sections.join('\n\n');
}

export function renderHeader(topic: string, agents?: Record<string, AgentState>): string {
  const title = `# ${topic}\n`;
  if (agents && Object.keys(agents).length > 0) {
    return title + '\n' + renderPanelists(agents) + '\n\n---\n\n## Epoch 1\n';
  }
  return title + '\n## Epoch 1\n';
}
