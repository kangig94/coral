export type ExecutionLifetime = 'host' | 'session' | 'turn';

export type ProviderExecutionPlan<Host = unknown, Session = unknown, Turn = unknown> = Readonly<{
  host: Host;
  session: Session;
  turn: Turn;
}>;

export type EnvironmentLayer = Readonly<{
  name: string;
  lifetime: ExecutionLifetime;
  provenance: string;
  values: Readonly<Record<string, string>>;
  writes: readonly string[];
  protects: readonly string[];
}>;

type EnvironmentLayerInput = Omit<EnvironmentLayer, 'writes' | 'protects'> &
  Readonly<{
    writes: Iterable<string>;
    protects: Iterable<string>;
  }>;

export const EXECUTION_ENV_ALLOWLIST = Object.freeze([
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
] as const);

export const CORAL_TURN_ENV_KEYS = Object.freeze(['CORAL_OWNER', 'CORAL_EFFORT'] as const);

export const CORAL_PROCESS_ENV_KEYS = Object.freeze(['CORAL_KB_PATH', 'CORAL_KB_ENABLE'] as const);

function foldedKey(key: string, platform: string): string {
  return platform === 'win32' ? key.toLowerCase() : key;
}

export function filterEnvironmentValues(
  values: Readonly<Record<string, string>>,
  allowed: Iterable<string>,
  platform: string,
): Readonly<Record<string, string>> {
  const allowedKeys = new Set([...allowed].map((key) => foldedKey(key, platform)));
  return Object.freeze(
    Object.fromEntries(Object.entries(values).filter(([key]) => allowedKeys.has(foldedKey(key, platform)))),
  );
}

function layerSource(layer: EnvironmentLayer): string {
  return `'${layer.name}' (${layer.provenance})`;
}

function canonicalKeys(keys: readonly string[], platform: string): ReadonlySet<string> {
  return new Set([...keys].map((key) => foldedKey(key, platform)));
}

function canonicalLayerKeys(keys: Iterable<string>, label: string): readonly string[] {
  const values = [...keys];
  const unique = new Set(values);
  if (unique.size !== values.length) {
    throw new Error(`provider_execution_environment_invalid: duplicate ${label} key`);
  }
  return Object.freeze([...unique].sort((left, right) => left.localeCompare(right)));
}

export function environmentLayer(layer: EnvironmentLayerInput, platform: string): EnvironmentLayer {
  const writes = canonicalLayerKeys(layer.writes, `${layer.name}.writes`);
  const allowed = canonicalKeys(writes, platform);
  const outsideWrites = Object.keys(layer.values).filter((key) => !allowed.has(foldedKey(key, platform)));
  if (outsideWrites.length > 0) {
    throw new Error(
      `provider_execution_environment_invalid: ${layerSource(layer as EnvironmentLayer)} contains values outside writes: ${outsideWrites.sort().join(', ')}`,
    );
  }
  return Object.freeze({
    name: layer.name,
    lifetime: layer.lifetime,
    provenance: layer.provenance,
    values: Object.freeze({ ...layer.values }),
    writes,
    protects: canonicalLayerKeys(layer.protects, `${layer.name}.protects`),
  });
}

export function compileEnvironmentLayers(
  layers: readonly EnvironmentLayer[],
  options: { readonly platform: string; readonly lifetimes: ReadonlySet<ExecutionLifetime> },
): Readonly<Record<string, string>> {
  const selected = layers.filter((layer) => options.lifetimes.has(layer.lifetime));
  const output: Record<string, string> = {};
  const written = new Map<string, { key: string; layer: EnvironmentLayer }>();
  const protectedBy = new Map<string, EnvironmentLayer>();

  for (const layer of selected) {
    for (const key of layer.protects) {
      const folded = foldedKey(key, options.platform);
      const prior = protectedBy.get(folded);
      if (prior !== undefined && prior !== layer) {
        throw new Error(
          `provider_execution_environment_invalid: protection collision '${key}' between ${layerSource(prior)} and ${layerSource(layer)}`,
        );
      }
      protectedBy.set(folded, layer);
    }
    const writes = canonicalKeys(layer.writes, options.platform);
    for (const [key, value] of Object.entries(layer.values)) {
      const folded = foldedKey(key, options.platform);
      if (!writes.has(folded)) continue;
      const prior = written.get(folded);
      if (prior !== undefined && prior.key !== key) {
        throw new Error(
          `provider_execution_environment_invalid: environment key collision '${prior.key}' from ${layerSource(prior.layer)} with '${key}' from ${layerSource(layer)}`,
        );
      }
      const owner = protectedBy.get(folded);
      if (owner !== undefined && owner !== layer) {
        throw new Error(
          `provider_execution_environment_invalid: protected environment collision '${key}' from ${layerSource(layer)} against ${layerSource(owner)}`,
        );
      }
      written.set(folded, { key, layer });
      output[key] = value;
    }
  }
  return Object.freeze(output);
}

export function allExecutionLifetimes(): ReadonlySet<ExecutionLifetime> {
  return new Set(['host', 'session', 'turn']);
}

export function hostExecutionLifetime(): ReadonlySet<ExecutionLifetime> {
  return new Set(['host']);
}
