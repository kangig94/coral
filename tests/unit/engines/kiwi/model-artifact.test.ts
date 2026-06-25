import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  extractKiwiModelFiles,
  extractKiwiModelFilesInWorker,
  KIWI_MODEL_TAR_MAX_BYTES,
} from '#src/engines/kiwi/model-artifact.js';
import { KIWI_MODEL_FILES, KIWI_MODEL_TAR_PREFIX } from '#src/engines/kiwi/constants.js';

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  Buffer.from(value, 'utf-8').copy(header, offset, 0, length);
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  Buffer.from(encoded, 'utf-8').copy(header, offset, 0, length);
}

function createTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, name, 0, 100);
  writeTarOctal(header, 0o644, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, size, 124, 12);
  writeTarOctal(header, Math.floor(Date.now() / 1000), 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = '0'.charCodeAt(0);
  writeTarString(header, 'ustar', 257, 6);
  writeTarString(header, '00', 263, 2);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  writeTarOctal(header, checksum, 148, 8);
  return header;
}

function createMalformedKiwiArchive(declaredSize: number): Buffer {
  const header = createTarHeader(`${KIWI_MODEL_TAR_PREFIX}${KIWI_MODEL_FILES[0]}`, declaredSize);
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024, 0)]));
}

function createCompleteKiwiArchive(): Buffer {
  const chunks: Buffer[] = [];
  for (const fileName of KIWI_MODEL_FILES) {
    const content = Buffer.from(`content:${fileName}`, 'utf-8');
    chunks.push(createTarHeader(`${KIWI_MODEL_TAR_PREFIX}${fileName}`, content.length));
    chunks.push(content);
    chunks.push(Buffer.alloc((512 - (content.length % 512)) % 512, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

describe('Kiwi model artifact extraction', () => {
  it('keeps the decompressed model archive cap bounded', () => {
    expect(KIWI_MODEL_TAR_MAX_BYTES).toBe(512 * 1024 * 1024);
  });

  it('rejects model archives above the decompressed byte cap', () => {
    const archive = gzipSync(Buffer.alloc(2048, 0));

    expect(() => extractKiwiModelFiles(archive, 1024)).toThrow(
      /Kiwi model archive exceeds maximum decompressed size \(1024 bytes\)/,
    );
  });

  it('rejects tar entries whose declared size exceeds the archive bounds', () => {
    expect(() => extractKiwiModelFiles(createMalformedKiwiArchive(4096))).toThrow(
      /Kiwi model archive entry exceeds archive bounds: models\/cong\/base\/sj\.morph/,
    );
  });

  it('extracts required model files in a worker', async () => {
    const files = await extractKiwiModelFilesInWorker(createCompleteKiwiArchive());

    expect(files.get('sj.morph')?.toString('utf-8')).toBe('content:sj.morph');
    expect(files.get('nounchr.mdl')?.toString('utf-8')).toBe('content:nounchr.mdl');
  });

  it('rejects model archives above the worker decompressed byte cap', async () => {
    const archive = gzipSync(Buffer.alloc(2048, 0));

    await expect(extractKiwiModelFilesInWorker(archive, 1024)).rejects.toThrow(
      /Kiwi model archive exceeds maximum decompressed size \(1024 bytes\)/,
    );
  });
});
