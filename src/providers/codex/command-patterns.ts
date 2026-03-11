import { shortPath } from '../../shared/format-progress.js';

type Rule = [RegExp, (m: RegExpMatchArray, sp: (path: string) => string) => string];

/** Remove surrounding quotes (single or double). Returns `s` unchanged if not quoted. */
function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// Reusable pattern fragments — handle "quoted", 'quoted', and unquoted forms
const FILE = String.raw`("[^"]+"|'[^']+'|\S+)`;
const NONDASH_FILE = String.raw`("[^"]+"|'[^']+'|[^-\s]\S*)`;
const SED_RANGE = String.raw`['"]?(\d+),(\d+)p['"]?`;

const RULES: Rule[] = [
  [new RegExp(String.raw`^nl\s+-ba\s+${FILE}\s*\|\s*sed\s+-n\s+${SED_RANGE}$`),
    (m, sp) => `Read(${sp(stripQuotes(m[1]))}:${m[2]}-${m[3]})`],
  [new RegExp(String.raw`^sed\s+-n\s+${SED_RANGE}\s+${FILE}$`),
    (m, sp) => `Read(${sp(stripQuotes(m[3]))}:${m[1]}-${m[2]})`],
  [new RegExp(String.raw`^nl\s+-ba\s+${FILE}$`),
    (m, sp) => `Read(${sp(stripQuotes(m[1]))})`],
  [new RegExp(String.raw`^cat\s+${NONDASH_FILE}$`),
    (m, sp) => `Read(${sp(stripQuotes(m[1]))})`],
  [/^rg\b.*?(?:"([^"]+)"|'([^']+)')/, (m, _sp) => `Grep(${m[1] ?? m[2]})`],
  [/^rg\s+(?:-\S+\s+)*([^-\s]\S*)/, (m, _sp) => `Grep(${m[1]})`],
];

const SHELL_HEAD = String.raw`(?:\/usr\/bin\/|\/bin\/)?(?:zsh|bash|sh)\s+(?:-lc|-c)\s+`;
const SHELL_PREFIX = new RegExp('^' + SHELL_HEAD);
const SHELL_CLEAN = new RegExp('^' + SHELL_HEAD + String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$`);
const CD_PREFIX = /^cd\s+\S+\s*&&\s*(.+)$/;

export function stripShellWrapper(command: string): string {
  const prefixMatch = command.match(SHELL_PREFIX);
  if (prefixMatch === null) return stripCdPrefix(command);

  // Try precise extraction first (balanced quotes with proper escaping)
  const cleanMatch = command.match(SHELL_CLEAN);
  if (cleanMatch !== null) {
    if (cleanMatch[1] !== undefined) {
      return stripCdPrefix(cleanMatch[1].replace(/\\"/g, '"'));
    }
    return stripCdPrefix(cleanMatch[2] ?? command);
  }

  // Fallback: peel outer quotes best-effort (handles unbalanced/POSIX quote-toggle)
  let payload = command.slice(prefixMatch[0].length);
  const hadDoubleQuotes = payload.length >= 2 && payload[0] === '"';
  payload = stripQuotes(payload);
  if (hadDoubleQuotes) payload = payload.replace(/\\"/g, '"');
  return stripCdPrefix(payload);
}

function stripCdPrefix(command: string): string {
  const match = command.match(CD_PREFIX);
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
