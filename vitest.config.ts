import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Тестовый файл ТЯЖЁЛЫЙ, если читает настоящий Power.log: партия весит
 * 35–80 МБ, и её разбор держит поток воркера синхронно по 5–20 секунд.
 * Признак берётся из текста файла, а не из каталога, потому что каталоги
 * смешанные: в test/parser и test/advisors есть и те и другие, а новая
 * партия почти всегда добавляет тест, читающий свой лог.
 *
 * Замер 15.09.2026: лёгких 43 файла и 625 тестов, проходят за 16 секунд;
 * тяжёлых 63 файла, из них 49 — test/state/partN.
 */
const READS_FIXTURE_LOG = /from '(?:\.\.\/)+fixtures\.js'|readFixtureGame|FIXTURES_DIR/;

function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFilesUnder(path));
    else if (entry.name.endsWith('.test.ts')) found.push(path);
  }
  return found;
}

const asGlob = (path: string): string => relative('.', path).split(sep).join('/');

const allTests = ['test', 'src'].flatMap(testFilesUnder);
const isFixtureTest = (path: string): boolean => READS_FIXTURE_LOG.test(readFileSync(join(ROOT, path), 'utf8'));
const fixtureTests = allTests.filter(isFixtureTest).map(asGlob);
const unitTests = allTests.filter((path) => !isFixtureTest(path)).map(asGlob);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Прогон fixture-логов целиком — десятки мегабайт, дефолтных 5 с не хватит.
    testTimeout: 30_000,
    /**
     * Живая сводка репортёра выключена — она опрашивает воркеры по RPC,
     * а тяжёлые тесты подолгу держат поток синхронной работой. 17.08 прогон
     * стал падать ошибкой «[vitest-worker]: Timeout calling "onTaskUpdate"»:
     * все тесты зелёные, а `npm test` возвращает ненулевой код.
     *
     * Настоящая причина найдена замером 15.09.2026, и это НЕ число воркеров:
     * тяжёлый набор при 15 воркерах дал 7 таких ошибок, при шести — 5, время
     * 287 против 272 секунд. Тайм-аут RPC у vitest — 60 секунд, из конфига
     * не меняется, и ошибку даёт любой синхронный кусок дольше минуты, даже
     * без единого соседнего воркера: part25 в одиночку — одна ошибка
     * и код 1 при шести зелёных тестах. Лечение — отдавать поток
     * (`test/breather.ts`); после него part25 в одиночку — ноль ошибок.
     * Поэтому `maxWorkers` здесь намеренно не ограничен.
     */
    reporters: [['default', { summary: false }]],
    /**
     * Два набора. `unit` идёт первой группой и не читает логов, поэтому
     * годится после каждой правки (`npm run check`). `fixtures` идёт второй
     * группой, когда лёгкие файлы уже не отнимают воркеров.
     *
     * Список тяжёлых считается при загрузке конфига. Файл, созданный
     * в режиме наблюдения, попадёт в свой набор после перезапуска vitest.
     *
     * Наборы разводятся через `exclude`, а не через `include`: при
     * `extends: true` массив `include` проекта СЛИВАЕТСЯ с корневым,
     * и набор «только тяжёлые» молча получал все 106 файлов.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...fixtureTests, '**/node_modules/**'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'fixtures',
          exclude: [...unitTests, '**/node_modules/**'],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
