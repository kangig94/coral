export function randomSuffix(): string {
  const suffix = Math.random().toString(36).slice(2, 6);
  return suffix.padEnd(4, '0');
}

export function formatDateId(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(2);
  return `${yy}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function topicSlug(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return 'untitled';
  if (slug.length <= 40) return slug;
  const cut = slug.lastIndexOf('-', 40);
  return cut > 0 ? slug.slice(0, cut) : slug.slice(0, 40);
}

export function parseDisplayName(persona: string, agentName: string): string {
  const firstLine = persona.split('\n')[0] ?? '';
  const stripped = firstLine.replace(/^#\s*/, '');
  const [, displayName] = stripped.match(/^(.+?)\s+[—–-]\s+/) ?? [];
  return displayName?.trim() || agentName;
}
