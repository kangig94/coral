#!/usr/bin/env node
//
// PreToolUse:Bash hook for coral-cli command resolution.
//
// Sections:
//   1. Entry-point constants
//   2. Invocation detection (bare coral-cli vs node <bridge>)
//   3. Command-shape helpers (global options, subcommand classification)
//   4. Rewriting primitives (bare → node, stale bridge → active)
//   5. Post-processing (inline text → tempfile, unsafe metachars, wait timeout)
//   6. Top-level orchestration (splitter + per-segment pipeline)
//   7. Main I/O

import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin } from './lib/hook-utils.mjs';
import {
  applyReplacements,
  shellQuote,
  splitTopLevelCommands,
  tokenizeShell as parseShellTokens,
} from './lib/shell-parser.mjs';
import {
  analyzeFlag,
  analyzeValueSegments,
  getInlineValueSegments,
  isExactToken,
} from './lib/flag-helpers.mjs';
import { BRIDGE_SUFFIX, activeBridgePath } from './lib/plugin-paths.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

// === 1. Entry-point constants ===

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTIVE_BRIDGE = activeBridgePath(PLUGIN_ROOT);
const BRIDGE_PREFIX = dirname(PLUGIN_ROOT);

const KNOWN_PROVIDER_COMMANDS = new Set(['codex', 'claude']);
const RESERVED_TOP_LEVEL_COMMANDS = new Set(['workflow', 'wait', 'abort', 'backend', 'discuss', 'kb', 'list']);
const SHORT_FLAGS_WITH_VALUES = new Set(['f', 'i', 's', 'w', 'm', 'o', 'e', 'c', 'p']);
const SHORT_BOOLEAN_FLAGS = new Set(['b', 'd']);

// Shell-grammar characters that cause parse errors when they appear in an unquoted token.
// Parentheses open subshells and braces start brace-expansion / function blocks — both can
// abort zsh parsing before the command runs. Glob characters like `*` and `?` are omitted
// because unmatched globs fall back to literal under default shell options rather than
// breaking the grammar.
const UNSAFE_UNQUOTED_METACHARS = /[()[\]{}]/u;

// Wraps the generic shell tokenizer with coral-specific validation:
// short-flag clusters that mix value-taking and boolean flags are ambiguous
// enough to be treated as non-parseable.
function tokenizeShell(command) {
  const tokens = parseShellTokens(command);
  if (tokens === null) return null;
  if (tokens.some(hasAmbiguousShortCluster)) return null;
  return tokens;
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

// === 2. Invocation detection ===

function detectCoralInvocation(tokens) {
  if (tokens.length < 1) return null;
  const first = tokens[0];

  if (
    first.value === 'coral-cli'
    && first.segments.length === 1
    && first.segments[0].kind === 'unquoted'
  ) {
    return { kind: 'bare' };
  }

  if (
    first.value === 'node'
    && tokens.length >= 2
    && tokens[1].value.endsWith(BRIDGE_SUFFIX)
  ) {
    return { kind: 'node' };
  }

  return null;
}

// === 3. Command-shape helpers ===

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

function skipGlobalOptions(tokens, startIndex) {
  let index = startIndex;
  while (index < tokens.length) {
    const width = getGlobalOptionWidth(tokens, index);
    if (width === null) return null;
    if (width === 0) return index;
    index += width;
  }
  return index;
}

function detectCommandShape(tokens) {
  const index = skipGlobalOptions(tokens, 2);
  if (index === null || index >= tokens.length) return null;

  const subcommand = tokens[index].value;
  if (subcommand.startsWith('-')) return null;
  if (subcommand === 'workflow') return { kind: 'workflow', startIndex: index + 1 };
  if (KNOWN_PROVIDER_COMMANDS.has(subcommand) || !RESERVED_TOP_LEVEL_COMMANDS.has(subcommand)) {
    return { kind: 'provider', startIndex: index + 1 };
  }

  return null;
}

// === 4. Rewriting primitives ===

function replaceBareCoralCli(segText, tokens) {
  const first = tokens[0];
  return applyReplacements(segText, [{
    start: first.start,
    end: first.end,
    text: `node ${shellQuote(ACTIVE_BRIDGE)}`,
  }]);
}

function rewriteStaleBridge(segText, tokens) {
  const scriptToken = tokens[1];
  if (existsSync(scriptToken.value)) return segText;
  if (!scriptToken.value.startsWith(`${BRIDGE_PREFIX}/`)) return segText;
  if (!scriptToken.value.endsWith(BRIDGE_SUFFIX)) return segText;

  const versionSeg = scriptToken.value.slice(
    BRIDGE_PREFIX.length + 1,
    -BRIDGE_SUFFIX.length,
  );
  if (!versionSeg || versionSeg.includes('/')) return segText;
  if (scriptToken.value === ACTIVE_BRIDGE) return segText;

  return applyReplacements(segText, [{
    start: scriptToken.start,
    end: scriptToken.end,
    text: shellQuote(ACTIVE_BRIDGE),
  }]);
}

// === 5. Post-processing ===

function writeInlineTextFile(value) {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  const filePath = join(tmpdir(), `coral-input-${hash}.txt`);
  writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600 });
  return filePath;
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

    if (matched.kind === 'quoted' && !existsSync(resolve(cwd, matched.value))) {
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

function detectWaitTimeoutSeconds(command) {
  const tokens = tokenizeShell(command);
  if (tokens === null || tokens.length < 3) return null;

  const index = skipGlobalOptions(tokens, 2);
  if (index === null || index >= tokens.length || tokens[index].value !== 'wait') return null;

  const DEFAULT_WAIT_TIMEOUT = 600;

  for (let i = index + 1; i < tokens.length; i += 1) {
    if (isExactToken(tokens[i], '--timeout')) {
      const next = tokens[i + 1];
      if (next === undefined) return DEFAULT_WAIT_TIMEOUT;
      const parsed = parseInt(next.value, 10);
      return Number.isNaN(parsed) ? DEFAULT_WAIT_TIMEOUT : parsed;
    }
    const inline = getInlineValueSegments(tokens[i], '--timeout=');
    if (inline !== null) {
      const analysis = analyzeValueSegments(inline);
      if (analysis.value !== undefined) {
        const parsed = parseInt(analysis.value, 10);
        return Number.isNaN(parsed) ? DEFAULT_WAIT_TIMEOUT : parsed;
      }
      return DEFAULT_WAIT_TIMEOUT;
    }
  }

  return DEFAULT_WAIT_TIMEOUT;
}

// === 6. Top-level orchestration ===

function processSegment(segText, input) {
  const tokens = tokenizeShell(segText);
  if (tokens === null) return { text: segText, waitTimeout: null, changed: false };

  const invocation = detectCoralInvocation(tokens);
  if (invocation === null) return { text: segText, waitTimeout: null, changed: false };

  let current = segText;
  if (invocation.kind === 'bare') {
    current = replaceBareCoralCli(current, tokens);
  } else {
    current = rewriteStaleBridge(current, tokens);
  }

  current = rewriteInlineTextArgs(current, input);
  current = wrapUnsafeUnquotedTokens(current);

  const waitTimeout = detectWaitTimeoutSeconds(current);

  return {
    text: current,
    waitTimeout,
    changed: current !== segText,
  };
}

function processCommand(command, input) {
  const segments = splitTopLevelCommands(command);
  if (segments === null) return null;

  let result = '';
  let cursor = 0;
  let maxWaitTimeout = null;
  let anyChange = false;

  for (const { start, end } of segments) {
    if (start > cursor) result += command.slice(cursor, start);

    const segText = command.slice(start, end);
    const { text, waitTimeout, changed } = processSegment(segText, input);
    result += text;

    if (waitTimeout !== null) {
      maxWaitTimeout = maxWaitTimeout === null ? waitTimeout : Math.max(maxWaitTimeout, waitTimeout);
    }
    if (changed) anyChange = true;

    cursor = end;
  }

  if (cursor < command.length) result += command.slice(cursor);

  return { command: result, waitTimeout: maxWaitTimeout, changed: anyChange };
}

// === 7. Main I/O (fail-open: any error → silent exit 0) ===

try {
  const input = JSON.parse(await readStdin());

  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    process.exit(0);
  }

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  const result = processCommand(command, input);
  if (result === null) process.exit(0);
  if (!result.changed && result.waitTimeout === null) process.exit(0);

  const updatedInput = { ...input.tool_input, command: result.command };
  if (result.waitTimeout !== null) {
    updatedInput.timeout = (result.waitTimeout + 10) * 1000;
    updatedInput.run_in_background = false;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'coral-cli auto-rewrite',
      updatedInput,
    },
  }) + '\n');
} catch {
  process.exit(0);
}
