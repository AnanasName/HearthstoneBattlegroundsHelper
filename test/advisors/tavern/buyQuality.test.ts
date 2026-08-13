import { beforeAll, describe, expect, it } from 'vitest';

import {
  agreementRate,
  averageCost,
  measureBuyQuality,
  type BuyComparison,
} from '../../../src/advisors/tavern/buyQuality.js';
import { createBattleSimulator, type BattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import { part4Game, part5Game, part7Game } from '../../fixtures.js';

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
    // Партии текущего патча: мерка — симулятор, а он отражает нынешние правила.
    for (const text of [part4Game(), part5Game(), part7Game()]) {
      // Порог «решал» поднят под шум 800 симуляций: стандартная ошибка
      // разности долей тут ~2.5 п.п., и порог обязан сидеть выше неё.
      const report = measureBuyQuality(
        text,
        { cards, simulator },
        { simulations: SIMULATIONS, decisiveSpread: 5 },
      );
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

  it('там, где выбор что-то решает, эвристика не хуже случайной', () => {
    // Слабое место, и порог не делает вид, что это не так. На партиях нового
    // патча решающих ходов набирается меньше десятка, совпадений на них
    // 35–60% в зависимости от зерна — против 20–33% у случайного выбора.
    // Решающий ход — это ранний бой, где борды из пары миньонов и исход
    // определяет один тонкий выбор, который без знания борда противника
    // не сделать. Выборка мала, порог сторожит лишь «не хуже случайного»;
    // настоящие числа печатает npm run validate:tavern.
    expect(agreementRate(decisive)).toBeGreaterThanOrEqual(0.25);
  });

  it('цена расхождения умеренна', () => {
    // На партиях старого патча выходило около 1 п.п.; на новых — около 6:
    // почти всё дают два промаха по ~50 п.п. на ранних боях, где борды
    // из одного-двух миньонов и один тонкий выбор решает бой целиком.
    // Плюс тёмные дары, которых маппер пока не передаёт симулятору.
    // Порог с запасом: он сторожит поломку весов, а не конкретное число.
    expect(averageCost(rows)).toBeLessThan(12);
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
