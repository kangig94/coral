import { shortPath } from '../../shared/format-progress.js';

type Rule = [RegExp, (m: RegExpMatchArray, sp: (path: string) => string) => string];

const RULES: Rule[] = [
  [/^nl\s+-ba\s+(\S+)\s*\|\s*sed\s+-n\s+'(\d+),(\d+)p'$/, (m, sp) => `Read(${sp(m[1])}:${m[2]}-${m[3]})`],
  [/^sed\s+-n\s+'(\d+),(\d+)p'\s+(\S+)$/, (m, sp) => `Read(${sp(m[3])}:${m[1]}-${m[2]})`],
  [/^nl\s+-ba\s+(\S+)$/, (m, sp) => `Read(${sp(m[1])})`],
  [/^cat\s+([^-\s]\S*)$/, (m, sp) => `Read(${sp(m[1])})`],
  [/^rg\b.*?"([^"]+)"/, (m, _sp) => `Grep(${m[1]})`],
  [/^rg\b.*?'([^']+)'/, (m, _sp) => `Grep(${m[1]})`],
  [/^rg\s+(?:-\S+\s+)*([^-\s]\S*)/, (m, _sp) => `Grep(${m[1]})`],
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

export function matchCommandPattern(command: string, projectRoot?: string): string | null {
  const sp = (path: string) => shortPath(path, projectRoot);
  for (const [re, format] of RULES) {
    const match = command.match(re);
    if (match) return format(match, sp);
  }
  return null;
}
