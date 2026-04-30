import type { Command } from 'commander';

export type CommandClass = 'read' | 'mutate' | 'subscribe';

export type StaticCommandPath =
  | 'jobs'
  | 'wait'
  | 'abort'
  | 'workflow'
  | 'expansion list'
  | 'expansion equip'
  | 'expansion unequip'
  | 'expansion update'
  | 'expansion info'
  | 'kb search'
  | 'kb diagnose'
  | 'kb principles'
  | 'kb read'
  | 'kb source import'
  | 'kb source list'
  | 'kb source delete'
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
  jobs: 'read',
  wait: 'subscribe',
  abort: 'mutate',
  workflow: 'mutate',
  'expansion list': 'read',
  'expansion equip': 'mutate',
  'expansion unequip': 'mutate',
  'expansion update': 'mutate',
  'expansion info': 'read',
  'kb search': 'read',
  'kb diagnose': 'read',
  'kb principles': 'read',
  'kb read': 'read',
  'kb source import': 'mutate',
  'kb source list': 'read',
  'kb source delete': 'mutate',
  'kb memo write': 'mutate',
  'kb memo list': 'read',
  'kb memo delete': 'mutate',
  'kb memo purge': 'mutate',
  'kb promote': 'mutate',
  'kb update': 'mutate',
  'kb delete': 'mutate',
  'kb reindex': 'mutate',
  'discuss seed': 'mutate',
  'discuss start': 'mutate',
  'discuss watch': 'read',
  'discuss participate': 'mutate',
  'discuss abort': 'mutate',
} as const satisfies Readonly<Record<StaticCommandPath, CommandClass>>;

export const commandContainerPaths = new Set<string>(['backend', 'discuss', 'expansion', 'kb', 'kb source', 'kb memo']);

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

    if (!commandContainerPaths.has(entry.path)) {
      problems.push(`Container command "${entry.path}" must be added to commandContainerPaths.`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`CLI command coverage invariant failed:\n- ${problems.join('\n- ')}`);
  }
}
