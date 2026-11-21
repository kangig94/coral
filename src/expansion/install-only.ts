import { CODEBASE_MEMORY_TOOL } from '../../clients/hooks/lib/equip-tools.mjs';
import { BUNDLED_INSTALL_ONLY_PACKAGES } from './bundled.js';
import type { InstallOnlyManifest } from './contract.js';
import { createShellInstaller } from './shell-installer.js';

const CODEBASE_MEMORY_INSTALL_URL = 'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh';

export const INSTALL_ONLY_PACKAGES: readonly InstallOnlyManifest[] = [
  ...BUNDLED_INSTALL_ONLY_PACKAGES,
  {
    id: CODEBASE_MEMORY_TOOL.id,
    version: 'latest',
    description:
      'Codebase Memory MCP — indexes your code into a graph for AI navigation. The official installer installs the binary and an updater and configures supported agents. Restart your agent to activate it.',
    installer: createShellInstaller(CODEBASE_MEMORY_TOOL, `curl -fsSL ${CODEBASE_MEMORY_INSTALL_URL} | bash`),
    onboarding: [
      {
        kind: 'confirm-download',
        message:
          'This downloads and runs the official codebase-memory-mcp installer (curl | bash) from github.com/DeusData/codebase-memory-mcp. It installs to ~/.local/bin and configures supported agents. The installer may create or overwrite the updater at ~/.local/bin/install.sh. Coral removes a verified legacy engine-directory copy for this build flavor after verifying the standard installation. Continue?',
      },
    ],
  },
];

export function resolveInstallOnlyManifest(name: string): InstallOnlyManifest | null {
  return INSTALL_ONLY_PACKAGES.find((entry) => entry.id === name) ?? null;
}
