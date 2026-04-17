// Detection helpers for coral-cli invocations inside shell commands.
// Shared by cli-resolve (Bash command rewriting) and cli-wait-guard
// (Monitor deny policy). These operate on token streams produced by
// shell-parser plus the flag-helpers semantic layer.

import { splitTopLevelCommands, tokenizeShell } from './shell-parser.mjs';
import { getInlineValueSegments, isExactToken } from './flag-helpers.mjs';
import { BRIDGE_SUFFIX } from './plugin-paths.mjs';

// Classifies the first tokens as a coral-cli invocation. Returns
// { kind: 'bare', subcommandStart: 1 } for `coral-cli ...` and
// { kind: 'node', subcommandStart: 2 } for `node <path>/coral-cli.cjs ...`.
export function detectCoralInvocation(tokens) {
  if (tokens.length < 1) return null;
  const first = tokens[0];

  if (
    first.value === 'coral-cli'
    && first.segments.length === 1
    && first.segments[0].kind === 'unquoted'
  ) {
    return { kind: 'bare', subcommandStart: 1 };
  }

  if (
    first.value === 'node'
    && tokens.length >= 2
    && tokens[1].value.endsWith(BRIDGE_SUFFIX)
  ) {
    return { kind: 'node', subcommandStart: 2 };
  }

  return null;
}

// Width (in tokens) of a known coral-cli global option at `index`:
//   0 if the token is not a global option
//   1 if it is an inline form (`--output-format=json`, `-fjson`)
//   2 if it is a separated form (`--output-format json`, `-f json`)
//   null if a separated form is missing its value
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

// Walks past coral-cli global options starting at `startIndex`, returning the
// index of the first non-option token (the subcommand) or null if a malformed
// option is encountered.
export function skipGlobalOptions(tokens, startIndex) {
  let index = startIndex;
  while (index < tokens.length) {
    const width = getGlobalOptionWidth(tokens, index);
    if (width === null) return null;
    if (width === 0) return index;
    index += width;
  }
  return index;
}

// Returns true when the given token stream invokes `coral-cli wait`.
// Used by cli-resolve to decide whether to inject a foreground Bash timeout.
export function tokensInvokeCoralWait(tokens) {
  const invocation = detectCoralInvocation(tokens);
  if (invocation === null) return false;

  const subIdx = skipGlobalOptions(tokens, invocation.subcommandStart);
  if (subIdx === null || subIdx >= tokens.length) return false;
  return tokens[subIdx].value === 'wait';
}

// Regex-based `coral-cli wait` detection for text that our tokenizer won't
// parse (redirections, `$?` expansions, etc.). Read-only, so failing to
// fire leaves behavior unchanged rather than corrupting the command.
const WAIT_INVOCATION_RE =
  /(?:^|[\s;|&])(?:coral-cli|node\s+["']?[^\s"']*coral-cli\.cjs["']?)(?:\s+(?:-f\s+\S+|--output-format(?:=|\s+)\S+))*\s+wait\b/;

export function textInvokesCoralWait(text) {
  return WAIT_INVOCATION_RE.test(text);
}

// Returns true when any top-level command segment invokes `coral-cli wait`.
// Used by cli-wait-guard to deny the command from the Monitor tool.
export function commandHasCoralWait(command) {
  const segments = splitTopLevelCommands(command);
  if (segments === null) return false;

  for (const { start, end } of segments) {
    const tokens = tokenizeShell(command.slice(start, end));
    if (tokens === null) continue;
    if (tokensInvokeCoralWait(tokens)) return true;
  }

  return false;
}
