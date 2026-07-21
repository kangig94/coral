import type {
  ProviderCredentialSetInput,
  ProviderCredentialSet,
  ProviderCredentialSourceRef,
} from '#src/runtime/provider-credentials.js';
import type { ProviderExecutionContext } from '#src/providers/contract.js';

export const TEST_CODEX_SOURCE = {
  version: 1,
  provider: 'codex',
  kind: 'home',
  home: '/home/user/.codex',
} as const satisfies ProviderCredentialSourceRef;

export const TEST_CLAUDE_SOURCE = {
  version: 1,
  provider: 'claude',
  kind: 'config-dir',
  configDir: '/home/user/.claude',
  projectsRoot: '/home/user/.claude/projects',
} as const satisfies ProviderCredentialSourceRef;

export const TEST_PROVIDER_CREDENTIALS = {
  version: 1,
  codex: TEST_CODEX_SOURCE,
  claude: TEST_CLAUDE_SOURCE,
} as const satisfies ProviderCredentialSet;

export const TEST_PROVIDER_CREDENTIAL_INPUT = {
  version: 1,
  codex: { kind: 'home', home: TEST_CODEX_SOURCE.home },
  claude: { kind: 'config-dir', configDir: TEST_CLAUDE_SOURCE.configDir },
} as const satisfies ProviderCredentialSetInput;

export const TEST_CODEX_CONTEXT = {
  provider: 'codex',
  source: TEST_CODEX_SOURCE,
  appServerEnv: { CODEX_HOME: TEST_CODEX_SOURCE.home },
} as const satisfies ProviderExecutionContext;

export const TEST_CLAUDE_CONTEXT = {
  provider: 'claude',
  source: TEST_CLAUDE_SOURCE,
  brokerEnv: {},
  controllerEnv: { CLAUDE_CONFIG_DIR: TEST_CLAUDE_SOURCE.configDir },
  projectsRoot: TEST_CLAUDE_SOURCE.projectsRoot,
} as const satisfies ProviderExecutionContext;
