// CLI-only multi-line and table builders. Domain code uses `infra/text.ts`
// for single-line shape helpers (truncate, ensureSentence); these helpers
// shape multi-line CLI output and are not used outside cli/format.

export function joinLines(lines: Array<string | undefined>): string {
  const present: string[] = [];
  for (const line of lines) {
    if (typeof line === 'string' && line.length > 0) {
      present.push(line);
    }
  }
  return present.join('\n');
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
  const widths = headers.map((header) => header.length);
  for (const row of rows) {
    for (let index = 0; index < headers.length; index += 1) {
      widths[index] = Math.max(widths[index], row[index]?.length ?? 0);
    }
  }

  const formatRow = (row: string[]) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');

  const lines = [formatRow(headers), formatRow(widths.map((width) => '-'.repeat(width)))];
  for (const row of rows) {
    lines.push(formatRow(row));
  }
  return lines.join('\n');
}
