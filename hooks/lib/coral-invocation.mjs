// Detection helpers for coral-cli invocations inside shell commands.
// Shared by cli-resolve (Bash command rewriting) and cli-wait-guard
// (Monitor deny policy). These operate on token streams produced by
// shell-parser plus the flag-helpers semantic layer.

import { splitTopLevelCommands, tokenizeShell } from './shell-parser.mjs';
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

// Returns true when the given token stream invokes `coral-cli wait`.
// Used by cli-resolve to decide whether to inject a foreground Bash timeout.
export function tokensInvokeCoralWait(tokens) {
  const invocation = detectCoralInvocation(tokens);
  if (invocation === null) return false;

  if (invocation.subcommandStart >= tokens.length) return false;
  return tokens[invocation.subcommandStart].value === 'wait';
}

// Regex-based `coral-cli wait` detection for text that our tokenizer won't
// parse (redirections, `$?` expansions, etc.). Read-only, so failing to
// fire leaves behavior unchanged rather than corrupting the command.
const WAIT_INVOCATION_RE =
  /(?:^|[\s;|&])(?:coral-cli|node\s+["']?[^\s"']*coral-cli\.cjs["']?)\s+wait\b/;

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
