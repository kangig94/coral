// Single-line text shape helpers. Domain layers may import these.
// CLI-only multi-line / table builders live in `cli/format/text.ts`.

export function truncate(text: string, maxLen = 80): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
