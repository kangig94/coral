import { isIP } from 'node:net';

function stripIpv6Brackets(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

export function normalizeRemoteAddressLiteral(value: string): string {
  const normalized = stripIpv6Brackets(value);
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? mapped : normalized;
  }
  if (isIP(normalized) === 6) {
    try {
      return stripIpv6Brackets(new URL(`http://[${normalized}]/`).hostname);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

function isLoopbackIpv4Literal(value: string): boolean {
  const octets = value.split('.');
  if (octets.length !== 4 || !octets.every((part) => /^\d+$/.test(part))) {
    return false;
  }
  const [first, ...rest] = octets.map((part) => Number(part));
  return first === 127 && rest.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) {
    return false;
  }

  const normalized = normalizeRemoteAddressLiteral(remoteAddress);
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return isLoopbackIpv4Literal(normalized);
}

export function assertRemoteAddressLiteral(value: string, label: string): string {
  const normalized = normalizeRemoteAddressLiteral(value);
  if (isIP(normalized) === 0) {
    throw new Error(`${label} must be an IP address literal`);
  }
  return normalized;
}
