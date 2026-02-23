#!/usr/bin/env node

/**
 * PermissionRequest hook — auto-approves Coral's internal Bash commands.
 * Matches specific patterns only (coral tmp directory operations).
 * Fail-open: any error exits silently (normal permission flow continues).
 */

const ALLOWED_PATTERNS = [
  /^mkdir -p .+\.claude\/coral\/tmp/,
  /^touch .+\.claude\/coral\/tmp\//,
];

try {
  const input = JSON.parse(await readStdin());
  const toolName = (input.tool_name || '').replace(/^proxy_/, '');
  if (toolName !== 'Bash') process.exit(0);

  const command = input.tool_input?.command;
  if (!command || typeof command !== 'string') process.exit(0);

  // Check each part of chained commands (&&)
  const parts = command.split('&&').map(p => p.trim());
  const allAllowed = parts.length > 0 && parts.every(
    part => ALLOWED_PATTERNS.some(pattern => pattern.test(part))
  );

  if (allAllowed) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'allow',
          reason: 'Coral internal state file operation',
        },
      },
    }));
  }
} catch {
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
