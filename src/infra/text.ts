// Single-line text shape helpers. Domain layers may import these.
// CLI-only multi-line / table builders live in `cli/format/text.ts`.

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemeSafePrefix(text: string, maxCodeUnits: number): string {
  let end = 0;
  for (const segment of GRAPHEME_SEGMENTER.segment(text)) {
    const nextEnd = segment.index + segment.segment.length;
    if (nextEnd > maxCodeUnits) break;
    end = nextEnd;
  }
  return text.slice(0, end);
}

export function truncate(text: string, maxLen = 80): string {
  return text.length > maxLen ? `${graphemeSafePrefix(text, maxLen)}...` : text;
}

const ESC = 0x1b;
const BEL = 0x07;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

function skipCsi(text: string, start: number): number {
  let index = start;
  while (index < text.length && text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x3f) index += 1;
  while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index += 1;
  return index < text.length && text.charCodeAt(index) >= 0x40 && text.charCodeAt(index) <= 0x7e ? index + 1 : start;
}

function skipControlString(text: string, start: number, acceptsBel: boolean): number {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((acceptsBel && code === BEL) || code === C1_ST) return index + 1;
    if (code === ESC && text.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return text.length;
}

function skipEscape(text: string, start: number): number {
  let index = start;
  while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index += 1;
  return index < text.length && text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x7e ? index + 1 : start;
}

function stripTerminalSequences(text: string): string {
  let plainText = '';
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5b) {
        index = skipCsi(text, index + 2);
      } else if (next === 0x5d) {
        index = skipControlString(text, index + 2, true);
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipControlString(text, index + 2, false);
      } else {
        index = skipEscape(text, index + 1);
      }
      continue;
    }
    if (code === C1_CSI) {
      index = skipCsi(text, index + 1);
      continue;
    }
    if (code === C1_OSC) {
      index = skipControlString(text, index + 1, true);
      continue;
    }
    if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) {
      index = skipControlString(text, index + 1, false);
      continue;
    }
    plainText += text[index];
    index += 1;
  }
  return plainText;
}

/* eslint-disable no-control-regex -- terminal and bidi controls are defined by code-point ranges */
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;
const BIDI_DISPLAY_CONTROL = /[\u202A-\u202E\u2066-\u2069]/gu;
/* eslint-enable no-control-regex */

/** Removes terminal controls and collapses whitespace for bounded single-line display fields. */
export function singleLineDisplayText(text: string): string {
  return stripTerminalSequences(text)
    .replace(BIDI_DISPLAY_CONTROL, '')
    .replace(TERMINAL_CONTROL, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
