// Generic text helpers shared across domains. Lives in infra so any layer can
// import without pulling in a domain. format-progress.ts focuses on tool-call
// rendering; this file holds string-shape predicates that keep growing as
// describers and outcome formatters accumulate.

export function truncate(text: string, maxLen = 80): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
