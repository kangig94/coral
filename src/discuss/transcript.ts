/**
 * Transcript file operations for discuss sessions.
 * Human-readable format with timestamps and soft 80 / hard 100 word-wrap.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
        // Grace zone: extend if current ends a sentence
        if (SENTENCE_END.test(current.trimEnd())) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      } else {
        // Past hard limit — flush current and start new line with word
        if (current) lines.push(current);
        // Word itself may exceed hard limit — let it through as-is
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines.join('\n');
}

/** Format a Date as [YYYY-MM-DD HH:mm:ss]. */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

/** Generate a one-line summary: first sentence or first ~100 chars at word boundary. */
export function generateOneLiner(content: string): string {
  // Strip wrapped newlines for summary — use first line or first sentence
  const flat = content.replace(/\n/g, ' ').trim();
  const sentenceEnd = flat.search(/[.!?]\s/u);
  if (sentenceEnd !== -1 && sentenceEnd < 120) {
    return flat.slice(0, sentenceEnd + 1);
  }
  if (flat.length <= 100) return flat;
  const cut = flat.lastIndexOf(' ', 100);
  return cut > 0 ? flat.slice(0, cut) + '…' : flat.slice(0, 100) + '…';
}

/** Initialize transcript file with topic header and Epoch 1 marker. */
export function initTranscript(filePath: string, topic: string): void {
  const content = `# ${topic}\n\n## Epoch 1\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Append a speech entry to the transcript. */
export function appendSpeech(filePath: string, agentName: string, content: string): void {
  const ts = formatTimestamp(new Date());
  const wrapped = wrapText(content);
  const entry = `\n### ${ts} ${agentName}\n${wrapped}\n`;
  fs.appendFileSync(filePath, entry, 'utf8');
}

/**
 * Append an epoch summary header + entry.
 * Called by the teamlead at the start of a new epoch BEFORE the first bid.
 */
export function appendEpochSummary(filePath: string, epoch: number, summary: string): void {
  const ts = formatTimestamp(new Date());
  const wrapped = wrapText(summary);
  const entry = `\n## Epoch ${epoch}\n\n### ${ts} Epoch Summary (by Teamlead)\n${wrapped}\n`;
  fs.appendFileSync(filePath, entry, 'utf8');
}

/** Read the full transcript file. */
export function readFull(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Parse speech blocks from transcript.
 * Returns array of { name, content } in order.
 */
function parseSpeeches(raw: string): Array<{ name: string; content: string }> {
  const speeches: Array<{ name: string; content: string }> = [];
  // Match ### [timestamp] AgentName blocks (skip "Epoch Summary" which is teamlead metadata)
  const blockRe = /^### \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (.+)$/gm;
  let match: RegExpExecArray | null;
  const positions: Array<{ name: string; start: number }> = [];

  while ((match = blockRe.exec(raw)) !== null) {
    positions.push({ name: match[1], start: match.index + match[0].length });
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].start : raw.length;
    // Find the start of the next ### marker to get real end of content
    const nextMarkerSearch = raw.indexOf('\n### ', positions[i].start);
    const contentEnd = nextMarkerSearch !== -1 && nextMarkerSearch < end ? nextMarkerSearch : end;
    const content = raw.slice(positions[i].start, contentEnd).trim();
    speeches.push({ name: positions[i].name, content });
  }

  return speeches;
}

/**
 * Read recent N speeches in full + earlier as one-line summaries.
 * lastN defaults to session's recent_turns.
 */
export function readRecent(filePath: string, lastN: number): string {
  const raw = readFull(filePath);
  if (!raw) return '';
  const speeches = parseSpeeches(raw);
  if (speeches.length === 0) return raw;

  const recentStart = Math.max(0, speeches.length - lastN);
  const olderSummaries = speeches.slice(0, recentStart).map((s) => `- ${s.name}: ${generateOneLiner(s.content)}`);
  const recentFull = speeches.slice(recentStart).map((s) => `### ${s.name}\n${s.content}`);

  const parts: string[] = [];
  if (olderSummaries.length > 0) {
    parts.push('## Earlier speeches (summary)\n' + olderSummaries.join('\n'));
  }
  if (recentFull.length > 0) {
    parts.push('## Recent speeches\n' + recentFull.join('\n\n'));
  }
  return parts.join('\n\n');
}

/** Read all speeches as one-line summaries. */
export function readSummary(filePath: string): string {
  const raw = readFull(filePath);
  if (!raw) return '';
  const speeches = parseSpeeches(raw);
  if (speeches.length === 0) return raw;
  return speeches.map((s) => `- ${s.name}: ${generateOneLiner(s.content)}`).join('\n');
}
