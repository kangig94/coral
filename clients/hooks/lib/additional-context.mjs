import { Buffer } from 'node:buffer';

export const MAX_ADDITIONAL_CONTEXT_BYTES = 8_000;

export function truncateUtf8(value, maxBytes, truncationMarker = '') {
  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.length <= maxBytes) return value;

  const markerBytes = Buffer.byteLength(truncationMarker, 'utf-8');
  if (markerBytes > maxBytes) throw new Error('Truncation marker exceeds the byte limit');

  let end = maxBytes - markerBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString('utf-8')}${truncationMarker}`;
}

export function fitAdditionalContext({ fixedContent, variableContent, trimNotice }) {
  const fixedBytes = Buffer.byteLength(fixedContent, 'utf-8');
  if (fixedBytes > MAX_ADDITIONAL_CONTEXT_BYTES) {
    throw new Error('Fixed hook context exceeds the host inline-size limit');
  }
  if (!variableContent) return fixedContent;

  const separator = '\n\n';
  const complete = `${fixedContent}${separator}${variableContent}`;
  if (Buffer.byteLength(complete, 'utf-8') <= MAX_ADDITIONAL_CONTEXT_BYTES) return complete;

  const suffix = `${separator}${trimNotice}`;
  const variableBytes = MAX_ADDITIONAL_CONTEXT_BYTES - Buffer.byteLength(`${fixedContent}${separator}${suffix}`);
  if (variableBytes < 0) {
    throw new Error('Fixed hook context leaves no room for its trim notice');
  }

  return `${fixedContent}${separator}${truncateUtf8(variableContent, variableBytes)}${suffix}`;
}
