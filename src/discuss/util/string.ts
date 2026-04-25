import { randomUUID } from 'node:crypto';

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export function randomSuffix(): string {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 4);
  return suffix.padEnd(4, '0');
}

export function formatDateId(d: Date): string {
  const yy = String(d.getFullYear()).slice(2);
  return `${yy}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
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
  return slug.slice(0, cut > 0 ? cut : 40);
}

export function parseDisplayName(persona: string, agentName: string): string {
  const headerLine = persona.split('\n', 1)[0] ?? '';
  const strippedHeader = headerLine.replace(/^#\s*/, '');
  const match = strippedHeader.match(/^(.+?)\s+[—–-]\s+/);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string should fall through to agentName
  return match?.[1]?.trim() || agentName;
}
