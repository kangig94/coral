import { basename } from 'node:path';

type Rule = [RegExp, (m: RegExpMatchArray) => string];

const RULES: Rule[] = [
  [/^nl\s+-ba\s+(\S+)\s*\|\s*sed\s+-n\s+'(\d+),(\d+)p'$/, (m) => `Read(${basename(m[1])}:${m[2]}-${m[3]})`],
  [/^sed\s+-n\s+'(\d+),(\d+)p'\s+(\S+)$/, (m) => `Read(${basename(m[3])}:${m[1]}-${m[2]})`],
  [/^nl\s+-ba\s+(\S+)$/, (m) => `Read(${basename(m[1])})`],
  [/^cat\s+([^-\s]\S*)$/, (m) => `Read(${basename(m[1])})`],
  [/^rg\b.*?"([^"]+)"/, (m) => `Grep(${m[1]})`],
  [/^rg\b.*?'([^']+)'/, (m) => `Grep(${m[1]})`],
  [/^rg\s+(?:-\S+\s+)*([^-\s]\S*)/, (m) => `Grep(${m[1]})`],
];

export function stripShellWrapper(command: string): string {
  const shellMatch = command.match(/^(?:\/usr\/bin\/|\/bin\/)?(?:zsh|bash|sh)\s+(?:-lc|-c)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/);
  if (shellMatch === null) return stripCdPrefix(command);
  if (shellMatch[1] !== undefined) {
    return stripCdPrefix(shellMatch[1].replace(/\\"/g, '"'));
  }
  return stripCdPrefix(shellMatch[2] ?? command);
}

function stripCdPrefix(command: string): string {
  const match = command.match(/^cd\s+\S+\s*&&\s*(.+)$/);
  return match ? match[1].trim() : command;
}

export function matchCommandPattern(command: string): string | null {
  for (const [re, format] of RULES) {
    const match = command.match(re);
    if (match) return format(match);
  }
  return null;
}
