import { describe, expect, it } from 'vitest';

import { loadFieldBoards } from '../../src/advisors/strength/boards.js';
import { loadCardIndex } from '../../src/data/cards.js';
import { poolFingerprint } from '../../src/data/pool.js';

/**
 * Поле бордов и снапшот карт уезжают в сборку вместе, и поле обязано быть
 * собрано на ТОМ ЖЕ пуле (D304): иначе сила стола меряет стол против норм
 * другой игры, а отчёт после партии молча перестаёт давать факты
 * расстановки. Обновил снапшот карт с ротацией пула — пересобери поле
 * (`npm run field:fit`); этот тест не даёт забыть.
 */
describe('поле бордов собрано на пуле нынешнего снапшота карт', () => {
  it('отпечаток пула поля совпадает с отпечатком снапшота', () => {
    const field = loadFieldBoards();
    expect(field).not.toBeNull();
    expect(field?.pool).toBe(poolFingerprint(loadCardIndex()));
  });
});
