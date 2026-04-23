import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // --- Global ignores ---
  {
    ignores: ['dist/', 'bridge/', 'node_modules/', '**/*.cjs', '**/*.mjs'],
  },

  // --- Base: JS recommended + TS type-checked ---
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // --- TypeScript parser options ---
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // =========================================================
  // Principle 1: No Silent Failures
  // Floating promises and misused async patterns cause crashes.
  // The pipe-executor ENOENT crash was exactly this.
  // =========================================================
  // (Already included in recommendedTypeChecked:
  //   no-floating-promises, no-misused-promises, await-thenable)

  // =========================================================
  // All TypeScript rules
  // =========================================================
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'tools/**/*.ts'],
    rules: {
      // -- Principle 2: Transport Safety --
      // console.log in MCP server code corrupts the stdio transport.
      'no-console': 'error',

      // -- Principle 3: Explicit Intent --
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',

      // -- Principle 4: Dead Code Lies --
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // Ensure re-thrown errors preserve the original cause for debugging
      'preserve-caught-error': 'error',

      // -- Principle 5: Safe Type Boundaries --
      // JSON.parse and dynamic patterns make no-unsafe-* too noisy.
      // Zod handles boundary validation. Relax these.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',

      // Prefer ?? over || to avoid falsy traps (0, "")
      '@typescript-eslint/prefer-nullish-coalescing': 'error',

      // Allow non-null assertion with awareness (warn, not error)
      '@typescript-eslint/no-non-null-assertion': 'error',

      // -- Relaxations --
      // These fire too often in valid patterns:
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },

  // =========================================================
  // Principle 2 (cont.): Backend code must use backendLog,
  // not process.stderr.write directly.
  // Applies to: execution/, kb/, workflow/ (backend process code)
  // =========================================================
  {
    files: ['src/execution/**/*.ts', 'src/kb/**/*.ts', 'src/workflow/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='stderr'][property.name='write']",
          message: 'Use backendLog from infra/backend-log.ts instead of process.stderr.write in backend code.',
        },
      ],
    },
  },

  // =========================================================
  // Test files: relax strict rules
  // =========================================================
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
      'no-useless-escape': 'off',
      'require-yield': 'off',
    },
  },

  // --- Prettier: disable conflicting style rules ---
  prettierConfig,
);
