import type { Command } from 'commander';

type RenderedCommandSelector = Readonly<{
  label: 'action' | 'clear' | 'discard' | 'command';
  includes?: string;
}>;

function parseCommand(command: string): string[] {
  const tokens = command
    .match(/"(?:[^"\\]|\\.)*"|\S+/gu)
    ?.map((token) => (token.startsWith('"') ? (JSON.parse(token) as string) : token));
  if (tokens?.[0] !== 'coral-cli') throw new Error(`Expected a complete coral-cli invocation, received ${command}`);
  return tokens;
}

export function operatorArtifactLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(?:action|clear|command|discard)=coral-cli\s/u.test(line));
}

export async function executeRenderedCommand(
  program: Command,
  output: string,
  selector: RenderedCommandSelector,
): Promise<readonly string[]> {
  const prefix = `${selector.label}=`;
  const line = output
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.startsWith(prefix) && (selector.includes === undefined || candidate.includes(selector.includes)),
    );
  if (line === undefined) {
    throw new Error(
      `Expected rendered ${selector.label} command${selector.includes ? ` for ${selector.includes}` : ''}`,
    );
  }
  const tokens = parseCommand(line.slice(prefix.length));
  await program.parseAsync(['node', ...tokens]);
  return tokens;
}
