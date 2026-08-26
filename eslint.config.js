import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    /**
     * Черновики замеров (`*-tmp.ts`, профили, дампы) в tsconfig не входят,
     * и типизированные правила на них падают ошибкой разбора — то есть
     * `npm run lint` краснеет от файлов, которые к проекту не относятся.
     * Тот же список исключён и в .gitignore, но flat-config eslint его
     * не читает, поэтому правило приходится повторять здесь.
     */
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/**',
      '*-tmp.ts',
      'scratch-*.ts',
      'scratch-*.mjs',
      '*-tmp.mjs',
      'analyze-prof*.mjs',
      'bench-prof*/**',
    ],
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
