import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TAVERN_RULES } from '../../../src/advisors/tavern/rules.js';
import { CARDS_PATH, createCardIndex } from '../../../src/data/cards.js';

/**
 * Охват текстовых шаблонов советника — какие карты режима ловит каждая таблица.
 *
 * Класс ошибки, ради которого это заведено, проект ловил руками минимум пять
 * раз: шаблон МОЛЧА перестаёт совпадать (пробел вместо `\s+` при переносе
 * строки, счёт цифрой вместо слова, «that much» вместо числа, «from your
 * Tier» вместо «of your»), правило гаснет, а на его месте в списке стоит
 * обычная покупка — тесты зелёные, игрок жалуется через партию. Числа
 * покрытия до сих пор были закреплены только у сил героя
 * (heroPowers.test.ts).
 *
 * Здесь любое изменение охвата — новая таблица, правка регэкспа, новый
 * снапшот карт — становится строкой диффа в `__snapshots__/patternCoverage.json`.
 * Формат смешанный намеренно: у узкой таблицы (до 40 карт) список карт —
 * виден конкретный промах; у широкой только число — список из тысячи карт
 * был бы шумом, а сдвиг числа и так заметен.
 *
 * Шаблоны компилируются так же, как их читает советник: массив — `RegExp(s, 'i')`,
 * словарь «ключ → слово» — `\b(?:слово)\b`, словарь «слово → число» — само слово.
 *
 * **Если тест упал — это сигнал, а не поломка.** Посмотреть дифф: ушла ли
 * карта, которую правило должно видеть, или пришла чужая. Законный сдвиг
 * (новая карта патча, новый шаблон) принимается `npx vitest run -u` на этом
 * файле вместе с правкой, которая его вызвала.
 */

const LIST_LIMIT = 40;

type Compiled = readonly [label: string, patterns: readonly RegExp[]];

function compile(key: string, value: unknown): Compiled[] {
  if (Array.isArray(value)) return [[key, value.map((s) => new RegExp(String(s), 'i'))]];
  if (typeof value === 'string') return [[key, [new RegExp(value, 'i')]]];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, inner]): Compiled[] => {
    if (typeof inner === 'string') return [[`${key}.${name}`, [new RegExp(`\\b(?:${inner})\\b`, 'i')]]];
    if (typeof inner === 'number') return [[`${key}.${name}`, [new RegExp(`\\b${name}\\b`, 'i')]]];
    return compile(`${key}.${name}`, inner);
  });
}

describe('охват текстовых шаблонов советника', () => {
  it('совпадает со снапшотом', async () => {
    const raw = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as { id?: unknown }[];
    const cards = createCardIndex(raw);
    const pool = raw
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string' && /^(BG|TB_BaconShop)/.test(id))
      .filter((id) => (cards.info(id)?.text ?? '') !== '')
      .sort();

    const coverage: Record<string, number | string[]> = {};
    for (const [key, value] of Object.entries(DEFAULT_TAVERN_RULES).sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.endsWith('Words')) continue;
      for (const [label, patterns] of compile(key, value)) {
        const hits = pool.filter((id) => patterns.some((re) => re.test(cards.info(id)?.text ?? '')));
        coverage[label] = hits.length <= LIST_LIMIT ? hits : hits.length;
      }
    }

    expect(Object.keys(coverage).length).toBeGreaterThan(50);
    await expect(`${JSON.stringify({ pool: pool.length, coverage }, null, 1)}\n`).toMatchFileSnapshot(
      '__snapshots__/patternCoverage.json',
    );
  }, 120_000);
});
