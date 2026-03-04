import { basename } from 'node:path';

type Rule = [RegExp, (m: RegExpMatchArray) => string];

const RULES: Rule[] = [
  [/^nl\s+-ba\s+(\S+)\s*\|\s*sed\s+-n\s+'(\d+),(\d+)p'$/, (m) => `Read(${basename(m[1])}:${m[2]}-${m[3]})`],
  [/^sed\s+-n\s+'(\d+),(\d+)p'\s+(\S+)$/, (m) => `Read(${basename(m[3])}:${m[1]}-${m[2]})`],
  [/^cat\s+([^-\s]\S*)$/, (m) => `Read(${basename(m[1])})`],
  [/^rg\b.*?"([^"]+)"/, (m) => `Grep(${m[1]})`],
  [/^rg\b.*?'([^']+)'/, (m) => `Grep(${m[1]})`],
  [/^rg\s+(?:-\S+\s+)*([^-\s]\S*)/, (m) => `Grep(${m[1]})`],
];

export function stripShellWrapper(command: string): string {
  const match = command.match(/^(?:\/usr\/bin\/|\/bin\/)?(?:zsh|bash|sh)\s+(?:-lc|-c)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/);
  if (match) return match[1] !== undefined ? match[1].replace(/\\"/g, '"') : (match[2] ?? command);
  return command;
}

export function matchCommandPattern(command: string): string | null {
  for (const [re, format] of RULES) {
    const match = command.match(re);
    if (match) return format(match);
  }
  return null;
}
