const EXECUTION_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

const SHARED_CORAL_REQUEST_ENV_KEYS = new Set(['CORAL_OWNER', 'CORAL_EFFORT', 'CORAL_KB_PATH', 'CORAL_KB_ENABLE']);

function foldedKey(key: string, windows: boolean): string {
  return windows ? key.toLowerCase() : key;
}

function setHasKey(keys: ReadonlySet<string>, key: string, windows: boolean): boolean {
  if (!windows) return keys.has(key);
  const folded = key.toLowerCase();
  for (const candidate of keys) {
    if (candidate.toLowerCase() === folded) return true;
  }
  return false;
}

export function buildExactProviderEnv(options: {
  baseEnv: Readonly<Record<string, string>>;
  requestEnv?: Readonly<Record<string, string>>;
  protectedEnv?: Readonly<Record<string, string>>;
  routingEnv?: Readonly<Record<string, string>>;
  protectedRequestKeys?: ReadonlySet<string>;
  allowedRequestKeys?: ReadonlySet<string>;
  platform: string;
}): Readonly<Record<string, string>> {
  const windows = options.platform === 'win32';
  const output: Record<string, string> = {};
  const seen = new Map<string, string>();
  const assign = (key: string, value: string): void => {
    const folded = foldedKey(key, windows);
    const prior = seen.get(folded);
    if (prior !== undefined && prior !== key) {
      throw new Error(`provider_execution_environment_invalid: environment key collision '${prior}'/'${key}'`);
    }
    seen.set(folded, key);
    output[key] = value;
  };
  for (const [key, value] of Object.entries(options.baseEnv)) {
    if (setHasKey(EXECUTION_ENV_ALLOWLIST, key, windows)) assign(key, value);
  }
  for (const [key, value] of Object.entries(options.requestEnv ?? {})) {
    if (setHasKey(options.protectedRequestKeys ?? new Set(), key, windows)) {
      throw new Error(`provider_execution_environment_invalid: protected environment override '${key}'`);
    }
    if (
      setHasKey(EXECUTION_ENV_ALLOWLIST, key, windows) ||
      setHasKey(SHARED_CORAL_REQUEST_ENV_KEYS, key, windows) ||
      setHasKey(options.allowedRequestKeys ?? new Set(), key, windows)
    ) {
      assign(key, value);
    }
  }
  for (const [key, value] of Object.entries(options.routingEnv ?? {})) {
    assign(key, value);
  }
  for (const [key, value] of Object.entries(options.protectedEnv ?? {})) assign(key, value);
  return Object.freeze(output);
}
