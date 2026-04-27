// Generic text helpers shared across domains. Lives in infra so any layer can
// import without pulling in a domain. Includes single-line shape predicates
// (truncate, ensureSentence) and multi-line / table builders (joinLines,
// formatTable, formatUnknown, appendCursor) — the unifying property is "no
// domain knowledge"; each helper accepts strings or generic values and
// returns strings.

export function truncate(text: string, maxLen = 80): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

export function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function joinLines(lines: Array<string | undefined>): string {
  return lines.filter((line): line is string => typeof line === 'string' && line.length > 0).join('\n');
}

export function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

export function appendCursor(text: string, cursor: string | null): string {
  return cursor === null ? text : `${text} (cursor: ${cursor})`;
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));

  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');

  return [formatRow(headers), formatRow(widths.map((width) => '-'.repeat(width))), ...rows.map(formatRow)].join('\n');
}
