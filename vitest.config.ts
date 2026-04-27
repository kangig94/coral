import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '#src': fileURLToPath(new URL('./src', import.meta.url)),
  '#tests': fileURLToPath(new URL('./tests', import.meta.url)),
  '#tools': fileURLToPath(new URL('./tools', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/invariants/**/*.test.ts', 'src/**/__tests__/*.test.ts'],
    exclude: ['ref/**', 'node_modules/**'],
    setupFiles: ['vitest.setup.ts'],
  },
});
