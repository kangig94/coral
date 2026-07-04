import type { EnvPort } from '../infra/port-types.js';

export const CORAL_KB_EXTRA_LANGS_ENV = 'CORAL_KB_EXTRA_LANGS';

export type KbDeclaredAnalyzer = 'ko';

const REGISTERED_KB_ANALYZERS: readonly KbDeclaredAnalyzer[] = ['ko'];

const REGISTERED_ANALYZER_SET: ReadonlySet<string> = new Set(REGISTERED_KB_ANALYZERS);

export type KbAnalyzerWarningSink = (message: string) => void;

export function parseDeclaredKbAnalyzers(
  raw: string | undefined,
  warn: KbAnalyzerWarningSink = () => {},
): readonly KbDeclaredAnalyzer[] {
  if (raw === undefined) {
    return [];
  }

  const declared = new Set<KbDeclaredAnalyzer>();
  const warnedUnknown = new Set<string>();
  for (const code of raw
    .trim()
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    if (REGISTERED_ANALYZER_SET.has(code)) {
      declared.add(code as KbDeclaredAnalyzer);
      continue;
    }

    if (!warnedUnknown.has(code)) {
      warnedUnknown.add(code);
      warn(`${CORAL_KB_EXTRA_LANGS_ENV}: unknown language code "${code}" has no registered analyzer; ignoring.`);
    }
  }

  return [...declared].sort((left, right) => left.localeCompare(right));
}

export function readDeclaredKbAnalyzersFromEnv(
  env: Pick<EnvPort, 'get'>,
  warn?: KbAnalyzerWarningSink,
): readonly KbDeclaredAnalyzer[] {
  return parseDeclaredKbAnalyzers(env.get(CORAL_KB_EXTRA_LANGS_ENV), warn);
}
