import type { Command } from 'commander';

export type CommandClass = 'directRead' | 'servedRead' | 'mutate' | 'subscribe';

export type StaticCommandPath =
  | 'jobs'
  | 'jobs detail'
  | 'wait jobs'
  | 'abort'
  | 'abort jobs'
  | 'workflow'
  | 'expansion list'
  | 'expansion equip'
  | 'expansion unequip'
  | 'expansion remove-catalog'
  | 'expansion update'
  | 'expansion info'
  | 'kb search'
  | 'kb diagnose'
  | 'kb merge-entity-graph'
  | 'kb merge-frontmatter'
  | 'kb principles'
  | 'kb read'
  | 'kb source import'
  | 'kb source list'
  | 'kb source delete'
  | 'kb community list-stale'
  | 'kb community summary-input'
  | 'kb community set-summary'
  | 'kb wiki create'
  | 'kb wiki rewrite'
  | 'kb wiki link'
  | 'kb wiki unlink'
  | 'kb wiki cite'
  | 'kb wiki adopt'
  | 'kb wiki delete'
  | 'kb wiki list'
  | 'kb wake-up'
  | 'kb memo write'
  | 'kb memo list'
  | 'kb memo delete'
  | 'kb memo purge'
  | 'kb promote'
  | 'kb update'
  | 'kb delete'
  | 'kb reindex'
  | 'discuss seed'
  | 'discuss start'
  | 'discuss watch'
  | 'discuss participate'
  | 'discuss abort';

export const commandClassMap = {
  jobs: 'directRead',
  'jobs detail': 'servedRead',
  'wait jobs': 'subscribe',
  abort: 'mutate',
  'abort jobs': 'mutate',
  workflow: 'mutate',
  'expansion list': 'directRead',
  'expansion equip': 'mutate',
  'expansion unequip': 'mutate',
  'expansion remove-catalog': 'mutate',
  'expansion update': 'mutate',
  'expansion info': 'directRead',
  'kb search': 'servedRead',
  'kb diagnose': 'directRead',
  'kb merge-entity-graph': 'mutate',
  'kb merge-frontmatter': 'mutate',
  'kb principles': 'directRead',
  'kb read': 'directRead',
  'kb source import': 'mutate',
  'kb source list': 'directRead',
  'kb source delete': 'mutate',
  'kb community list-stale': 'directRead',
  'kb community summary-input': 'directRead',
  'kb community set-summary': 'mutate',
  'kb wiki create': 'mutate',
  'kb wiki rewrite': 'mutate',
  'kb wiki link': 'mutate',
  'kb wiki unlink': 'mutate',
  'kb wiki cite': 'mutate',
  'kb wiki adopt': 'mutate',
  'kb wiki delete': 'mutate',
  'kb wiki list': 'directRead',
  'kb wake-up': 'directRead',
  'kb memo write': 'mutate',
  'kb memo list': 'directRead',
  'kb memo delete': 'mutate',
  'kb memo purge': 'mutate',
  'kb promote': 'mutate',
  'kb update': 'mutate',
  'kb delete': 'mutate',
  'kb reindex': 'mutate',
  'discuss seed': 'mutate',
  'discuss start': 'mutate',
  'discuss watch': 'directRead',
  'discuss participate': 'mutate',
  'discuss abort': 'mutate',
} as const satisfies Readonly<Record<StaticCommandPath, CommandClass>>;

export const commandContainerPaths = new Set<string>([
  'backend',
  'discuss',
  'expansion',
  'kb',
  'wait',
  'kb source',
  'kb community',
  'kb wiki',
  'kb memo',
]);

export const commandClassExemptions = {
  'backend status': 'local operational health probe',
  'backend shutdown': 'local operational drain request',
} as const;

const providerCommandFamily = new WeakSet<Command>();

export type CommandCoverageResolution =
  | { kind: 'class'; commandClass: CommandClass; source: 'map' | 'provider-family' }
  | { kind: 'container' }
  | { kind: 'exempt'; rationale: string }
  | { kind: 'unclassified' };

export type CommandCoverageEntry = {
  command: Command;
  path: string;
  isLeaf: boolean;
  resolution: CommandCoverageResolution;
};

export function markProviderCommand(command: Command): void {
  providerCommandFamily.add(command);
}

export function isProviderCommand(command: Command): boolean {
  return providerCommandFamily.has(command);
}

export function commandPath(command: Command): string {
  const segments: string[] = [];
  let current: Command | null = command;

  while (current?.parent) {
    segments.unshift(current.name());
    current = current.parent;
  }

  return segments.join(' ');
}

export function classifyCommand(command: Command): CommandCoverageResolution {
  const path = commandPath(command);

  if (path.length === 0) {
    return { kind: 'container' };
  }

  if (commandContainerPaths.has(path)) {
    return { kind: 'container' };
  }

  if (Object.prototype.hasOwnProperty.call(commandClassMap, path)) {
    return {
      kind: 'class',
      commandClass: commandClassMap[path as StaticCommandPath],
      source: 'map',
    };
  }

  if (isProviderCommand(command)) {
    return {
      kind: 'class',
      commandClass: 'mutate',
      source: 'provider-family',
    };
  }

  if (Object.prototype.hasOwnProperty.call(commandClassExemptions, path)) {
    return {
      kind: 'exempt',
      rationale: commandClassExemptions[path as keyof typeof commandClassExemptions],
    };
  }

  return { kind: 'unclassified' };
}

function walkCommands(root: Command, visit: (command: Command) => void): void {
  for (const command of root.commands) {
    visit(command);
    walkCommands(command, visit);
  }
}

export function collectCommandCoverage(program: Command): CommandCoverageEntry[] {
  const entries: CommandCoverageEntry[] = [];

  walkCommands(program, (command) => {
    entries.push({
      command,
      path: commandPath(command),
      isLeaf: command.commands.length === 0,
      resolution: classifyCommand(command),
    });
  });

  return entries;
}

export function assertCommandClassCoverage(program: Command): void {
  const problems: string[] = [];

  for (const entry of collectCommandCoverage(program)) {
    if (entry.path.length === 0) {
      continue;
    }

    if (entry.isLeaf) {
      if (entry.resolution.kind === 'container') {
        problems.push(`Leaf command "${entry.path}" is marked as a container path.`);
        continue;
      }

      if (entry.resolution.kind === 'unclassified') {
        problems.push(`Leaf command "${entry.path}" is missing a command-class entry or exemption.`);
      }

      continue;
    }

    if (entry.resolution.kind === 'class') {
      continue;
    }

    if (!commandContainerPaths.has(entry.path)) {
      problems.push(`Container command "${entry.path}" must be added to commandContainerPaths.`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`CLI command coverage invariant failed:\n- ${problems.join('\n- ')}`);
  }
}
