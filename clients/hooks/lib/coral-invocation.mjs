// Detects coral-cli invocations in Bash command text without parsing it. A
// detection may add to the command or its timeout, never rewrite what the shell
// will read. A match also auto-approves the whole command, so detection stays
// on command position: `coral-cli` merely mentioned as an argument must not match.

// Words that may precede a command name without being the command themselves.
const COMMAND_LEAD = String.raw`(?:(?:[A-Za-z_]\w*=\S*|time|!|\{|if|then|elif|else|while|until|do)\s+)*`;

// `coral-cli` in command position: at the start of a line, after a command
// separator, or opening a subshell / command substitution.
const COMMAND_POSITION = String.raw`(?:^|[\n;&|(\x60])\s*${COMMAND_LEAD}coral-cli`;

const INVOCATION_RE = new RegExp(`${COMMAND_POSITION}(?=\\s|$|[;&|)\\x60])`);
const WAIT_INVOCATION_RE = new RegExp(`${COMMAND_POSITION}\\s+wait\\b`);

export function textInvokesCoralCli(text) {
  return INVOCATION_RE.test(text);
}

export function textInvokesCoralWait(text) {
  return WAIT_INVOCATION_RE.test(text);
}
