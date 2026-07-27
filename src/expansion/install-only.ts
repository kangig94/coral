import { join } from 'node:path';
import { BUNDLED_INSTALL_ONLY_PACKAGES } from './bundled.js';
import type { InstallOnlyManifest } from './contract.js';
import { createShellInstaller } from './shell-installer.js';

const CODEBASE_MEMORY_INSTALL_URL = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh';
const CODEBASE_MEMORY_BINARY = 'codebase-memory-mcp';

/** POSIX single-quote a path so it survives `bash -c "<pipeline>"`. */
function singleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const INSTALL_ONLY_PACKAGES: readonly InstallOnlyManifest[] = [
  ...BUNDLED_INSTALL_ONLY_PACKAGES,
  {
    id: 'codebase-memory',
    version: 'latest',
    description:
      'Codebase Memory MCP — indexes your code into a graph for AI navigation; its install script installs the codebase-memory-mcp binary (with graph UI) and registers it as an MCP server (agent restart required to activate)',
    installer: createShellInstaller({
      packageId: 'codebase-memory',
      binaryPath: (binDir) => join(binDir, CODEBASE_MEMORY_BINARY),
      buildInstallCommand: (binDir) =>
        `curl -fsSL ${CODEBASE_MEMORY_INSTALL_URL} | bash -s -- --ui --dir=${singleQuote(binDir)}`,
      // The binary self-updates and tears down its own agent registrations.
      buildUpdateCommand: (binary) => `${singleQuote(binary)} update`,
      buildUninstallCommand: (binary) => `${singleQuote(binary)} uninstall`,
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
