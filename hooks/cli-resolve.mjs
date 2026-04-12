#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KNOWN_PROVIDER_COMMANDS = new Set(['codex', 'claude']);
const RESERVED_TOP_LEVEL_COMMANDS = new Set(['workflow', 'wait', 'abort', 'backend', 'discuss', 'kb', 'list']);
const SHORT_FLAGS_WITH_VALUES = new Set(['f', 'i', 's', 'w', 'm', 'o', 'e', 'c', 'p']);
const SHORT_BOOLEAN_FLAGS = new Set(['b', 'd']);

function shellQuote(value) {
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

function hasAmbiguousShortCluster(token) {
  const firstSegment = token.segments[0];
  if (firstSegment?.kind !== 'unquoted') return false;

  const prefix = firstSegment.value;
  if (!prefix.startsWith('-') || prefix.startsWith('--') || prefix === '-') return false;

  const firstFlag = prefix[1];
  const bundledFlags = prefix.slice(1);
  const isBooleanBundle = /^[A-Za-z]+$/.test(bundledFlags)
    && bundledFlags.split('').every((flag) => SHORT_BOOLEAN_FLAGS.has(flag));

  if (isBooleanBundle) {
    return token.segments.length > 1;
  }

  if (prefix.length === 2) {
    return token.segments.length > 1 && SHORT_BOOLEAN_FLAGS.has(firstFlag);
  }

  return !SHORT_FLAGS_WITH_VALUES.has(firstFlag);
}

function tokenizeShell(command) {
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

      if (
        char === '\\'
        || char === '$'
        || char === '`'
        || char === ';'
        || char === '<'
        || char === '>'
        || char === '|'
        || char === '&'
      ) {
        return null;
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

    const token = {
      start,
      end: index,
      raw: command.slice(start, index),
      value,
      segments,
    };

    if (hasAmbiguousShortCluster(token)) return null;
    tokens.push(token);
  }

  return tokens;
}

function isExactToken(token, value) {
  return token.segments.length === 1 && token.segments[0].kind === 'unquoted' && token.value === value;
}

function getInlineValueSegments(token, prefix) {
  const firstSegment = token.segments[0];
  if (firstSegment?.kind !== 'unquoted') return null;
  if (!firstSegment.value.startsWith(prefix)) return null;
  if (firstSegment.value === prefix && token.segments.length === 1) return null;

  const valueSegments = [];
  const remainder = firstSegment.value.slice(prefix.length);
  if (remainder.length > 0) {
    valueSegments.push({
      kind: 'unquoted',
      raw: firstSegment.raw.slice(prefix.length),
      value: remainder,
    });
  }

  valueSegments.push(...token.segments.slice(1));
  return valueSegments;
}

function analyzeValueSegments(segments) {
  if (segments.length === 0) {
    return { kind: 'unquoted', value: '' };
  }

  if (segments.length === 1) {
    const [segment] = segments;
    return segment.kind === 'unquoted'
      ? { kind: 'unquoted', value: segment.value }
      : { kind: 'quoted', value: segment.value };
  }

  return segments.some((segment) => segment.kind !== 'unquoted')
    ? { kind: 'complex' }
    : { kind: 'unquoted', value: segments.map((segment) => segment.value).join('') };
}

function getGlobalOptionWidth(tokens, index) {
  const token = tokens[index];
  if (token === undefined) return null;

  if (isExactToken(token, '--output-format') || isExactToken(token, '-f')) {
    return tokens[index + 1] === undefined ? null : 2;
  }

  if (getInlineValueSegments(token, '--output-format=') !== null || getInlineValueSegments(token, '-f') !== null) {
    return 1;
  }

  return 0;
}

function detectCommandShape(tokens) {
  let index = 2;

  while (index < tokens.length) {
    const globalOptionWidth = getGlobalOptionWidth(tokens, index);
    if (globalOptionWidth === null) return null;
    if (globalOptionWidth > 0) {
      index += globalOptionWidth;
      continue;
    }

    const subcommand = tokens[index].value;
    if (subcommand.startsWith('-')) return null;
    if (subcommand === 'workflow') return { kind: 'workflow', startIndex: index + 1 };
    if (KNOWN_PROVIDER_COMMANDS.has(subcommand) || !RESERVED_TOP_LEVEL_COMMANDS.has(subcommand)) {
      return { kind: 'provider', startIndex: index + 1 };
    }

    return null;
  }

  return null;
}

function resolveExistingPath(candidate, cwd) {
  return existsSync(resolve(cwd, candidate));
}

function writeInlineTextFile(value) {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const filePath = join(tmpdir(), `coral-input-${hash}.txt`);
  writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(filePath, 0o600);
  return filePath;
}

function applyReplacements(command, replacements) {
  if (replacements.length === 0) return command;

  let output = command;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.text}${output.slice(replacement.end)}`;
  }
  return output;
}

// Shell-grammar characters that cause parse errors when they appear in an unquoted token.
// Parentheses open subshells and braces start brace-expansion / function blocks — both can
// abort zsh parsing before the command runs. Glob characters like `*` and `?` are omitted
// because unmatched globs fall back to literal under default shell options rather than
// breaking the grammar.
const UNSAFE_UNQUOTED_METACHARS = /[()[\]{}]/u;

function wrapUnsafeUnquotedTokens(command) {
  const tokens = tokenizeShell(command);
  if (tokens === null) return command;

  const replacements = [];
  for (const token of tokens) {
    const hasUnsafeUnquotedSegment = token.segments.some(
      (segment) => segment.kind === 'unquoted' && UNSAFE_UNQUOTED_METACHARS.test(segment.value),
    );
    if (!hasUnsafeUnquotedSegment) continue;

    replacements.push({
      start: token.start,
      end: token.end,
      text: shellQuote(token.value),
    });
  }

  return applyReplacements(command, replacements);
}

function analyzeSeparateValue(tokens, index) {
  const valueToken = tokens[index + 1];
  if (valueToken === undefined) return null;

  const analysis = analyzeValueSegments(valueToken.segments);
  return {
    ...analysis,
    nextIndex: index + 1,
    replacement: {
      start: valueToken.start,
      end: valueToken.end,
      prefix: '',
    },
  };
}

function analyzeInlineValue(token, prefix) {
  const segments = getInlineValueSegments(token, prefix);
  if (segments === null) return null;

  const analysis = analyzeValueSegments(segments);
  return {
    ...analysis,
    replacement: {
      start: token.start,
      end: token.end,
      prefix,
    },
  };
}

function analyzeFlag(tokens, index, { short, long }) {
  const token = tokens[index];
  if (token === undefined) return null;

  if (isExactToken(token, short) || isExactToken(token, long)) {
    return analyzeSeparateValue(tokens, index);
  }

  return analyzeInlineValue(token, `${long}=`) ?? analyzeInlineValue(token, short);
}

function rewriteInlineTextArgs(command, input) {
  const tokens = tokenizeShell(command);
  if (tokens === null || tokens.length < 2) return command;

  const commandShape = detectCommandShape(tokens);
  if (commandShape === null) return command;

  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const targetFlags = commandShape.kind === 'workflow'
    ? [
        { short: '-s', long: '--start-prompt' },
        { short: '-c', long: '--context' },
      ]
    : [
        { short: '-i', long: '--input' },
      ];
  const replacements = [];

  for (let index = commandShape.startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '--') break;

    let matched = null;
    for (const flag of targetFlags) {
      matched = analyzeFlag(tokens, index, flag);
      if (matched !== null) break;
    }

    if (matched === null) continue;
    if (matched.kind === 'complex') return command;

    if (matched.kind === 'quoted' && !resolveExistingPath(matched.value, cwd)) {
      const tempPath = writeInlineTextFile(matched.value);
      const quotedPath = shellQuote(tempPath);
      replacements.push({
        start: matched.replacement.start,
        end: matched.replacement.end,
        text: `${matched.replacement.prefix}${quotedPath}`,
      });
    }

    index = matched.nextIndex ?? index;
  }

  return applyReplacements(command, replacements);
}

// Fail-open: any error -> silent exit 0
try {
  const input = JSON.parse(await readStdin());

  // Only handle Bash PreToolUse
  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    process.exit(0);
  }

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  // Match ONLY when the first executable token (after optional leading whitespace)
  // is the bare, unquoted word "coral-cli" followed by whitespace or end-of-string.
  // Do NOT match: "coral-cli" (quoted), 'coral-cli' (quoted), env=val coral-cli,
  // bash -c '...coral-cli...', or coral-cli appearing later in pipeline.
  const match = command.match(/^(\s*)coral-cli(\s|$)(.*)/s);
  if (!match) process.exit(0);

  const cliPath = join(PLUGIN_ROOT, 'bridge', 'coral-cli.cjs');
  const rewritten = `${match[1]}node "${cliPath}"${match[2]}${match[3]}`;
  const commandWithInlineTextResolved = rewriteInlineTextArgs(rewritten, input);
  const commandSafeForShell = wrapUnsafeUnquotedTokens(commandWithInlineTextResolved);

  const updatedInput = { ...input.tool_input, command: commandSafeForShell };
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
    },
  }) + '\n');
} catch {
  process.exit(0);
}
