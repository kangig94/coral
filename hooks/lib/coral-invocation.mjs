// Detection helpers for coral-cli invocations inside shell commands.
// Shared by cli-resolve (Bash command rewriting) and cli-wait-guard
// (Monitor deny policy). These operate on token streams produced by
// shell-parser plus the flag-helpers semantic layer.

import { splitTopLevelCommands, tokenizeShell } from './shell-parser.mjs';
import { analyzeValueSegments, getInlineValueSegments, isExactToken } from './flag-helpers.mjs';
import { BRIDGE_SUFFIX } from './plugin-paths.mjs';

const DEFAULT_WAIT_TIMEOUT = 600;

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
export function getGlobalOptionWidth(tokens, index) {
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

// If the command invokes `coral-cli wait`, returns its --timeout value in
// seconds (falling back to DEFAULT_WAIT_TIMEOUT when the flag is absent or
// unparseable); otherwise returns null.
export function detectWaitTimeoutSeconds(command) {
  const tokens = tokenizeShell(command);
  if (tokens === null) return null;

  const invocation = detectCoralInvocation(tokens);
  if (invocation === null) return null;

  const subIdx = skipGlobalOptions(tokens, invocation.subcommandStart);
  if (subIdx === null || subIdx >= tokens.length || tokens[subIdx].value !== 'wait') return null;

  for (let i = subIdx + 1; i < tokens.length; i += 1) {
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

// Returns true when any top-level command segment invokes `coral-cli wait`.
// Used by cli-wait-guard to deny the command from the Monitor tool.
export function commandHasCoralWait(command) {
  const segments = splitTopLevelCommands(command);
  if (segments === null) return false;

  for (const { start, end } of segments) {
    const tokens = tokenizeShell(command.slice(start, end));
    if (tokens === null) continue;
    const invocation = detectCoralInvocation(tokens);
    if (invocation === null) continue;
    const subIdx = skipGlobalOptions(tokens, invocation.subcommandStart);
    if (subIdx === null || subIdx >= tokens.length) continue;
    if (tokens[subIdx].value === 'wait') return true;
  }

  return false;
}
