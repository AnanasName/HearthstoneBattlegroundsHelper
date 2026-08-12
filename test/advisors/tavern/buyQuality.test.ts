import { beforeAll, describe, expect, it } from 'vitest';

import {
  agreementRate,
  averageCost,
  measureBuyQuality,
  type BuyComparison,
} from '../../../src/advisors/tavern/buyQuality.js';
import { createBattleSimulator, type BattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import { part2Game, part3Game } from '../../fixtures.js';

/**
 * Регрессия на качество эвристик покупки.
 *
 * Юнит-тесты правил проверяют, что код считает как задумано; здесь
 * проверяется, что задумано не абы как. Мерка внешняя — симулятор боя.
 *
 * Пороги намеренно мягче фактических значений: тест ловит поломку весов,
 * а не сторожит конкретные проценты. Актуальные числа печатает
 * `npm run validate:tavern`, разбор — в docs/tavern.md.
 *
 * Симуляций меньше, чем в скрипте: 800 хватает, чтобы отличить осмысленный
 * порядок от случайного, и не превращает прогон тестов в минутный.
 */
const SIMULATIONS = 800;

describe('эвристика покупок против симулятора', () => {
  let rows: BuyComparison[] = [];
  let decisive: BuyComparison[] = [];

  beforeAll(() => {
    const cards: CardIndex = loadCardIndex();
    const simulator: BattleSimulator = createBattleSimulator();

    rows = [];
    decisive = [];
    for (const text of [part2Game(), part3Game()]) {
      const report = measureBuyQuality(text, { cards, simulator }, { simulations: SIMULATIONS });
      rows.push(...report.rows);
      decisive.push(...report.decisive);
    }
  }, 180_000);

  it('сравнивать есть что', () => {
    expect(rows.length).toBeGreaterThanOrEqual(12);
    // Ходы, где любой выбор давал один и тот же исход, ничего не проверяют.
    // Если таких вдруг станут все, тест обязан это заметить.
    expect(decisive.length).toBeGreaterThanOrEqual(4);
  });

  it('совет заметно чаще совпадает с симулятором, чем случайный выбор', () => {
    // Случайный выбор из 3–5 кандидатов дал бы 20–33%. Фактически около 78%.
    expect(agreementRate(rows)).toBeGreaterThan(0.5);
  });

  it('там, где выбор что-то решает, эвристика тоже держится', () => {
    // Фактически около 75%; порог с запасом на дрожание Монте-Карло.
    expect(agreementRate(decisive)).toBeGreaterThan(0.4);
  });

  it('цена расхождения мала', () => {
    // Фактически около 1 п.п. ожидаемого исхода на ход.
    expect(averageCost(rows)).toBeLessThan(5);
    expect(averageCost(rows)).toBeGreaterThanOrEqual(0);
  });

  it('совет никогда не хуже худшего кандидата', () => {
    // Условие слабое, но нарушить его можно только перепутанным знаком
    // в сравнении — а такую ошибку проценты совпадений скрывают.
    for (const r of rows) {
      expect(r.bestOutcome).toBeGreaterThanOrEqual(r.heuristicOutcome - 1e-9);
      expect(r.spread).toBeGreaterThanOrEqual(r.bestOutcome - r.heuristicOutcome - 1e-9);
    }
  });
});
