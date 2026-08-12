import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Конфиги на чистом JS вне tsconfig — без правил, требующих типов.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Preload для Electron обязан быть CommonJS: он грузится раньше всего
    // остального и модульной системы проекта не разделяет. Под
    // verbatimModuleSyntax в CommonJS-файле пишут `import =`, и запрет
    // на require здесь означал бы запрет на сам файл.
    files: ['**/*.cts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
