import { join } from 'node:path';
import type { EngineInstaller, OnboardingStep } from './contract.js';
import { createShellInstaller } from './shell-installer.js';

/**
 * An install-only package installs a local binary and never activates inside
 * the coordinator (`activation: 'none'`). Unlike an engine it fills no `kb.*`
 * binding and has no `specifier` — `equip` installs it and stops.
 */
export interface InstallOnlyManifest {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly installer: EngineInstaller;
  readonly onboarding?: readonly OnboardingStep[];
}

const CODEBASE_MEMORY_INSTALL_URL = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh';
const CODEBASE_MEMORY_BINARY = 'codebase-memory-mcp';

/** POSIX single-quote a path so it survives `bash -c "<pipeline>"`. */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const INSTALL_ONLY_PACKAGES: readonly InstallOnlyManifest[] = [
  {
    id: 'codebase-memory',
    version: 'latest',
    description:
      'Codebase Memory MCP — indexes your code into a graph for AI navigation; its install script installs the codebase-memory-mcp binary (with graph UI) and registers it as an MCP server (agent restart required to activate)',
    installer: createShellInstaller({
      binaryPath: (binDir) => join(binDir, CODEBASE_MEMORY_BINARY),
      buildInstallCommand: (binDir) =>
        `curl -fsSL ${CODEBASE_MEMORY_INSTALL_URL} | bash -s -- --ui --dir=${singleQuote(binDir)}`,
    }),
    onboarding: [
      {
        kind: 'confirm-download',
        message:
          'This downloads and runs the codebase-memory-mcp install script (curl | bash) from github.com/DeusData/codebase-memory-mcp, installs the binary under Coral’s engine data directory, and registers it as an MCP server in your agent config. Continue?',
      },
    ],
  },
];

export function resolveInstallOnlyManifest(name: string): InstallOnlyManifest | null {
  return INSTALL_ONLY_PACKAGES.find((entry) => entry.id === name) ?? null;
}
