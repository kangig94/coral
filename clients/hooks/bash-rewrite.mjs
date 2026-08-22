#!/usr/bin/env node
//
// PreToolUse:Bash hook — the single owner of Bash command rewriting. Two jobs:
//   - resolve coral-cli invocations to the plugin-local bundle (+ wait foreground)
//   - wrap `run_in_background` commands so they record their own lifecycle in the
//     live-work registry (lib/live-work-registry.mjs beginBgTask), giving Stop
//     hooks a way to tell whether backgrounded work is still running.
//
// Invocation detection and wait-subcommand helpers live in
// hooks/lib/coral-invocation.mjs.
//
// Sections:
//   1. Entry-point constants
//   2. Subcommand shape detection (workflow / provider classification)
//   3. Rewriting primitives (bare → node, stale bridge → active)
//   4. Post-processing (inline text → tempfile, unsafe metachars)
//   5. Top-level orchestration (splitter + per-segment pipeline)
//   6. Main I/O (coral resolution + background-task wrapping)

import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, writeHookOutput } from './lib/hook-utils.mjs';
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
import { BRIDGE_SUFFIX, activeBridgePath, projectDirFromInput } from './lib/plugin-paths.mjs';
import { beginBgTask } from './lib/live-work-registry.mjs';
import {
  detectCoralInvocation,
  textInvokesCoralWait,
  tokensInvokeCoralWait,
} from './lib/coral-invocation.mjs';
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

// Bash rejects timeouts above 600_000 ms, so this is the ceiling, not a choice. A bounded wait derives its
// own deadline from this value minus a flush margin (see FOLLOW_TIMEOUT_SECONDS in src/cli/follow.ts) so it
// finishes first: it exits 75 with a printed resume command when work is still running. The command has a
// cursor after observed progress, but can be cursor-free when initial backend recovery/shutdown retries
// exhaust; the command and exit code would both be lost if Bash killed the process mid-write.
const WAIT_BASH_TIMEOUT_MS = 600_000;

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

// === 2. Subcommand shape detection ===

function detectCommandShape(tokens) {
  if (tokens.length <= 2) return null;

  const subcommand = tokens[2].value;
  if (subcommand.startsWith('-')) return null;
  if (subcommand === 'workflow') return { kind: 'workflow', startIndex: 3 };
  if (KNOWN_PROVIDER_COMMANDS.has(subcommand) || !RESERVED_TOP_LEVEL_COMMANDS.has(subcommand)) {
    return { kind: 'provider', startIndex: 3 };
  }

  return null;
}

// === 3. Rewriting primitives ===

function replaceBareCoralCli(segText, tokens) {
  const first = tokens[0];
  return applyReplacements(segText, [{
    start: first.start,
    end: first.end,
    text: `node "${ACTIVE_BRIDGE}"`,
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
    text: `"${ACTIVE_BRIDGE}"`,
  }]);
}

// === 4. Post-processing ===

function writeInlineTextFile(value) {
  const id = randomBytes(8).toString('hex');
  const filePath = join(tmpdir(), `coral-input-${id}.txt`);
  writeFileSync(filePath, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
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

// === 5. Top-level orchestration ===

// When the segment contains grammar that our tokenizer won't parse (`$VAR`,
// `$(...)`, unquoted `\`, ambiguous short cluster, unterminated quote),
// we still want to rewrite a leading bare `coral-cli` so the command is
// actually runnable. The flag-aware post-processing (inline text,
// metachar wrapping) is skipped for these segments.
const BARE_CORAL_CLI_RE = /^(\s*)coral-cli(\s|$)(.*)$/s;

function fallbackBareRewrite(segText) {
  const invokesWait = textInvokesCoralWait(segText);
  const match = segText.match(BARE_CORAL_CLI_RE);
  if (match === null) return { text: segText, invokesWait, changed: false };
  const text = `${match[1]}node "${ACTIVE_BRIDGE}"${match[2]}${match[3]}`;
  return { text, invokesWait, changed: true };
}

function processSegment(segText, input) {
  const tokens = tokenizeShell(segText);
  if (tokens === null) return fallbackBareRewrite(segText);

  const invocation = detectCoralInvocation(tokens);
  if (invocation === null) return { text: segText, invokesWait: false, changed: false };

  let current = segText;
  if (invocation.kind === 'bare') {
    current = replaceBareCoralCli(current, tokens);
  } else {
    current = rewriteStaleBridge(current, tokens);
  }

  current = rewriteInlineTextArgs(current, input);
  current = wrapUnsafeUnquotedTokens(current);

  return {
    text: current,
    invokesWait: tokensInvokeCoralWait(tokens),
    changed: current !== segText,
  };
}

function processCommand(command, input) {
  const segments = splitTopLevelCommands(command);
  if (segments === null) {
    const fallback = fallbackBareRewrite(command);
    if (!fallback.changed && !fallback.invokesWait) return null;
    return {
      command: fallback.changed ? fallback.text : command,
      invokesWait: fallback.invokesWait,
      changed: fallback.changed,
    };
  }

  let result = '';
  let cursor = 0;
  let invokesWait = false;
  let anyChange = false;

  for (const { start, end } of segments) {
    if (start > cursor) result += command.slice(cursor, start);

    const segText = command.slice(start, end);
    const segResult = processSegment(segText, input);
    result += segResult.text;

    if (segResult.invokesWait) invokesWait = true;
    if (segResult.changed) anyChange = true;

    cursor = end;
  }

  if (cursor < command.length) result += command.slice(cursor);

  return { command: result, invokesWait, changed: anyChange };
}

// === 6. Main I/O (coral resolution + background-task wrapping; fail-open) ===

try {
  const input = JSON.parse(await readStdin());

  if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'Bash') {
    process.exit(0);
  }

  const command = input.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);

  const result = processCommand(command, input);
  const updatedInput = { ...input.tool_input };
  let nextCommand = result?.command ?? command;
  let changed = result?.changed ?? false;
  const invokesWait = result?.invokesWait ?? false;

  // coral-cli wait blocks up to ~590s: extend the Bash timeout so a foreground
  // wait isn't killed early. run_in_background is left to the caller — a
  // backgrounded wait is tracked like any other background command below. (The
  // model is still guided to run wait foreground so its terminal JSON returns
  // directly; that's guidance now, not enforced here.)
  if (invokesWait) {
    updatedInput.timeout = WAIT_BASH_TIMEOUT_MS;
  }

  // Wrap any command that will actually run in the background so it records its
  // own start/liveness/exit in the live-work registry. Best-effort: beginBgTask
  // returns null (⇒ command left unwrapped) on invalid session or I/O error.
  if (updatedInput.run_in_background === true) {
    const bg = beginBgTask(projectDirFromInput(input), input.session_id);
    if (bg) {
      nextCommand = `${bg.wrapper}\n${nextCommand}`;
      changed = true;
    }
  }

  if (!changed && !invokesWait) process.exit(0);
  updatedInput.command = nextCommand;

  writeHookOutput({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'bash auto-rewrite',
      updatedInput,
    },
  });
} catch {
  process.exit(0);
}
