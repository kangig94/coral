import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __BUNDLE_DIR__: string | undefined;

export function durableWrapperEntrypoint(): string {
  if (typeof __BUNDLE_DIR__ === 'string') return join(__BUNDLE_DIR__, 'coral-durable-wrapper.cjs');
  return fileURLToPath(new URL('../../dist/runtime/durable-cli-wrapper.js', import.meta.url));
}
