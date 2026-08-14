// Single-line text shape helpers. Domain layers may import these.
// CLI-only multi-line / table builders live in `cli/format/text.ts`.

export function truncate(text: string, maxLen = 80): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

/* eslint-disable no-control-regex -- terminal control syntax is defined by control bytes */
const ANSI_SEQUENCE =
  /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[ -/]*[@-~])/gu;
const TERMINAL_CONTROL = /[\u0000-\u001F\u007F-\u009F]/gu;
/* eslint-enable no-control-regex */

/** Removes terminal controls and collapses whitespace for bounded single-line display fields. */
export function singleLineDisplayText(text: string): string {
  return text.replace(ANSI_SEQUENCE, '').replace(TERMINAL_CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

export function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
