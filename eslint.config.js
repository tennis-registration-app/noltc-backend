import tseslint from 'typescript-eslint';

export default tseslint.config(
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
  {
    ignores: ['node_modules/', 'supabase/functions/*/index.ts'],
  },
);
