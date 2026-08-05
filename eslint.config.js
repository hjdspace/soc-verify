import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'out',
      'dist',
      'node_modules',
      'resources/binaries',
      'engine/oh-my-pi',
      '.tmp',
      '.cache'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/jsx-uses-react': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    files: ['src/main/**/*', 'src/preload/**/*', 'src/shared/**/*'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['electron.vite.config.ts', 'vitest.config.ts', 'eslint.config.js', 'tests/**/*'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Tests use require() inside vi.hoisted() for dynamic imports in Vitest
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // Node.js scripts (ESM .mjs / CJS .cjs)
    files: ['scripts/**/*'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // CJS scripts legitimately use require()
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // Plugin files are CommonJS modules loaded at runtime
    files: ['plugins/**/*'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // Runner is a Node.js TypeScript file
    files: ['runner/**/*'],
    languageOptions: { globals: { ...globals.node } }
  }
);
