// Generic shell-command parser used by hook scripts.
// No domain coupling — callers layer their own semantics (e.g., flag ambiguity,
// invocation detection, stale-path rewriting) on top of the token stream.
//
// Token shape:
//   { start, end, raw, value, segments }
//     - start, end: offsets in the original command string
//     - raw:        original slice (command.slice(start, end))
//     - value:      concatenated segment values (post-unquoting)
//     - segments:   [{ kind: 'unquoted'|'single'|'double', raw, value }, ...]

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function readQuotedSegment(command, start) {
  const quote = command[start];
  let index = start + 1;
  let value = '';

  while (index < command.length) {
    const char = command[index];

    if (quote === '"' && char === '\\') {
      const next = command[index + 1];
      if (next === undefined) return null;

      if (next === '"' || next === '\\' || next === '$' || next === '`') {
        value += next;
      } else if (next === '\n') {
        // Shell line-continuation inside double quotes.
      } else {
        value += `\\${next}`;
      }

      index += 2;
      continue;
    }

    if (char === quote) {
      index += 1;
      return {
        nextIndex: index,
        segment: {
          kind: quote === '"' ? 'double' : 'single',
          raw: command.slice(start, index),
          value,
        },
      };
    }

    value += char;
    index += 1;
  }

  return null;
}

// Tokenizes a single command (no top-level operators). Returns null when the
// command contains grammar the caller cannot safely handle: unquoted `\`, `$`,
// `` ` ``, `;`, `<`, `>`, `|`, `&`. Use splitTopLevelCommands upstream to peel
// off `&&`/`||`/`;`/`|` separators before passing each segment here.
export function tokenizeShell(command) {
  const tokens = [];
  let index = 0;

  while (index < command.length) {
    while (index < command.length && /\s/u.test(command[index])) {
      index += 1;
    }
    if (index >= command.length) break;

    const start = index;
    const segments = [];
    let value = '';

    while (index < command.length && !/\s/u.test(command[index])) {
      const char = command[index];

      if (char === '\'' || char === '"') {
        const quoted = readQuotedSegment(command, index);
        if (quoted === null) return null;
        segments.push(quoted.segment);
        value += quoted.segment.value;
        index = quoted.nextIndex;
        continue;
      }

      const segmentStart = index;
      while (index < command.length) {
        const current = command[index];
        if (/\s/u.test(current) || current === '\'' || current === '"') break;
        if (
          current === '\\'
          || current === '$'
          || current === '`'
          || current === ';'
          || current === '<'
          || current === '>'
          || current === '|'
          || current === '&'
        ) {
          return null;
        }
        index += 1;
      }

      const raw = command.slice(segmentStart, index);
      segments.push({ kind: 'unquoted', raw, value: raw });
      value += raw;
    }

    tokens.push({
      start,
      end: index,
      raw: command.slice(start, index),
      value,
      segments,
    });
  }

  return tokens;
}

// Splits a command into top-level segments separated by &&, ||, ;, |.
// Returns null only when the grammar cannot be safely partitioned:
// backgrounding `&`, `|&`, or unterminated quotes. Other shell
// metacharacters (backslash, `$`, backtick, `<>`, `()`, `{}`) are left
// in place — the downstream tokenizer decides whether a given segment
// is parseable. Each returned segment is { start, end } (offsets in the
// original string); separator text is preserved implicitly by the gap.
export function splitTopLevelCommands(command) {
  const segments = [];
  let inSQ = false;
  let inDQ = false;
  let start = 0;
  let i = 0;

  while (i < command.length) {
    const c = command[i];

    if (inSQ) {
      if (c === "'") inSQ = false;
      i += 1;
      continue;
    }
    if (inDQ) {
      if (c === '\\' && i + 1 < command.length) { i += 2; continue; }
      if (c === '"') inDQ = false;
      i += 1;
      continue;
    }

    if (c === "'") { inSQ = true; i += 1; continue; }
    if (c === '"') { inDQ = true; i += 1; continue; }

    if (c === '&') {
      if (command[i + 1] === '&') {
        segments.push({ start, end: i });
        i += 2;
        start = i;
        continue;
      }
      return null;
    }

    if (c === '|') {
      if (command[i + 1] === '|') {
        segments.push({ start, end: i });
        i += 2;
        start = i;
        continue;
      }
      if (command[i + 1] === '&') return null;
      segments.push({ start, end: i });
      i += 1;
      start = i;
      continue;
    }

    if (c === ';') {
      segments.push({ start, end: i });
      i += 1;
      start = i;
      continue;
    }

    i += 1;
  }

  if (inSQ || inDQ) return null;
  segments.push({ start, end: command.length });
  return segments;
}

// Applies non-overlapping replacements to a string. Each replacement is
// { start, end, text }. Replacements are sorted internally, so callers may
// pass them in any order.
export function applyReplacements(command, replacements) {
  if (replacements.length === 0) return command;

  let output = command;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
  }
  return output;
}
