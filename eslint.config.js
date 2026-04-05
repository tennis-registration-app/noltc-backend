import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Shared modules and test files — full TypeScript-ESLint rules
  {
    files: [
      'supabase/functions/_shared/**/*.ts',
      'tests/**/*.ts',
    ],
    extends: [
      ...tseslint.configs.recommended,
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  // Edge Function entrypoints — same rules, plus Deno runtime globals
  // (Deno.env, Deno.serve, etc. are available at runtime but unknown to Node's type system)
  {
    files: ['supabase/functions/*/index.ts'],
    extends: [
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: {
        Deno: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    ignores: ['node_modules/'],
  },
);
