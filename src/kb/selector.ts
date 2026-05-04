export type KbReadKind = 'note' | 'source' | 'community' | 'memo' | 'principle' | 'wiki';

export type KbReadSelector = {
  kind: KbReadKind | null;
  slug: string;
};

export type KbResolvedReadSelector = {
  kind: KbReadKind;
  slug: string;
};

const NOTE_SLUG_PATTERN = /^[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/;
const MARKDOWN_EXTENSION = /\.md$/i;

export const KB_BARE_READ_ORDER = [
  'memo',
  'note',
  'wiki',
  'community',
  'source',
  'principle',
] as const satisfies readonly KbReadKind[];
export const KB_MEMO_FILENAME_PATTERN = /^\d{8}-\d{6}-.+$/;

function assertNonEmptyText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must be non-empty`);
  }
  return normalized;
}

function normalizeKbReadSlug(value: string, label: string): string {
  const trimmed = assertNonEmptyText(value, label);
  const normalized = trimmed.replace(MARKDOWN_EXTENSION, '');
  if (!NOTE_SLUG_PATTERN.test(normalized)) {
    throw new Error(`${label} must be slug-safe`);
  }
  return normalized;
}

export function parseKbSelector(input: string): KbReadSelector {
  const separatorIndex = input.indexOf(':');
  if (separatorIndex === -1) {
    return {
      kind: null,
      slug: normalizeKbReadSlug(input, 'note'),
    };
  }

  const kind = input.slice(0, separatorIndex);
  const slug = input.slice(separatorIndex + 1);

  if (kind === 'sources') {
    return {
      kind: 'source',
      slug: normalizeKbReadSlug(slug, 'source'),
    };
  }

  if (kind === 'communities') {
    return {
      kind: 'community',
      slug: normalizeKbReadSlug(slug, 'community'),
    };
  }

  if (kind === 'wiki') {
    return {
      kind: 'wiki',
      slug: normalizeKbReadSlug(slug, 'wiki'),
    };
  }

  return {
    kind: null,
    slug: normalizeKbReadSlug(input, 'note'),
  };
}

export function isKbMemoCandidateSlug(slug: string): boolean {
  return KB_MEMO_FILENAME_PATTERN.test(normalizeKbReadSlug(slug, 'note'));
}

export function expandKbReadSelector(selector: KbReadSelector): KbResolvedReadSelector[] {
  if (selector.kind !== null) {
    return [{ kind: selector.kind, slug: selector.slug }];
  }

  return KB_BARE_READ_ORDER.flatMap((kind) => {
    if (kind === 'memo' && !isKbMemoCandidateSlug(selector.slug)) {
      return [];
    }

    return [{ kind, slug: selector.slug }];
  });
}
