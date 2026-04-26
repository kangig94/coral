export const pad2 = (n: number): string => String(n).padStart(2, '0');

export function parseDisplayName(persona: string, agentName: string): string {
  const headerLine = persona.split('\n', 1)[0] ?? '';
  const strippedHeader = headerLine.replace(/^#\s*/, '');
  const match = strippedHeader.match(/^(.+?)\s+[—–-]\s+/);
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string should fall through to agentName
  return match?.[1]?.trim() || agentName;
}
