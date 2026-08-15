import { describe, expect, it } from 'vitest';

import { createCardStats, statGainOf } from '../../src/data/cardStats.js';
import { createCardIndex } from '../../src/data/cards.js';

/**
 * Чтение снапшота статистики карт.
 *
 * Модуль живёт ВНЕ рантайма советника (замер 15.08 сказал «пользы
 * не показано», docs/cardstats.md), но остаётся инструментом: по нему
 * проверяются будущие гипотезы. Проверяется то, на чём замер мог бы
 * молча соврать: знак impact, центрирование по тиру и отбор.
 */

const cards = createCardIndex([
  { id: 'T1_GOOD', name: 'Хорош', type: 'Minion', techLevel: 1, races: [], isBaconPool: true },
  { id: 'T1_BAD', name: 'Плох', type: 'Minion', techLevel: 1, races: [], isBaconPool: true },
  { id: 'T5_GOOD', name: 'Поздний', type: 'Minion', techLevel: 5, races: [], isBaconPool: true },
  { id: 'T5_BAD', name: 'Поздний слабый', type: 'Minion', techLevel: 5, races: [], isBaconPool: true },
  { id: 'RARE', name: 'Редкий', type: 'Minion', techLevel: 3, races: [], isBaconPool: true },
  { id: 'TRINKET', name: 'Тринкет', type: 'Battleground_trinket', isBaconPool: true },
]);

/** Место тем лучше, чем МЕНЬШЕ: у сильной карты impact отрицателен. */
const raw = {
  cardStats: [
    { cardId: 'T1_GOOD', totalPlayed: 100_000, averagePlacement: 3.0, averagePlacementOther: 4.0 },
    { cardId: 'T1_BAD', totalPlayed: 100_000, averagePlacement: 4.4, averagePlacementOther: 4.0 },
    { cardId: 'T5_GOOD', totalPlayed: 50_000, averagePlacement: 2.0, averagePlacementOther: 4.0 },
    { cardId: 'T5_BAD', totalPlayed: 50_000, averagePlacement: 3.6, averagePlacementOther: 4.0 },
    // Малая выборка — отбрасывается порогом.
    { cardId: 'RARE', totalPlayed: 10, averagePlacement: 1.0, averagePlacementOther: 4.0 },
    // Не миньон — не наше дело.
    { cardId: 'TRINKET', totalPlayed: 100_000, averagePlacement: 3.0, averagePlacementOther: 4.0 },
  ],
};

describe('статистика мест миньонов', () => {
  const stats = createCardStats(raw, cards);

  it('берёт только миньонов пула с достаточной выборкой', () => {
    expect(stats.size).toBe(4);
    expect(stats.stat('RARE')).toBeNull();
    expect(stats.stat('TRINKET')).toBeNull();
  });

  it('impact отрицателен у сильной карты', () => {
    expect(stats.stat('T1_GOOD')?.impact).toBeCloseTo(-1.0);
    expect(stats.stat('T1_BAD')?.impact).toBeCloseTo(0.4);
  });

  it('центрирование по тиру снимает тировую часть', () => {
    // Тир 1: impact −1.0 и +0.4, среднее −0.3.
    expect(stats.tierMean(1)).toBeCloseTo(-0.3);
    expect(stats.stat('T1_GOOD')?.residual).toBeCloseTo(-0.7);
    // Тир 5: −2.0 и −0.4, среднее −1.2. Сырой impact у T5_BAD (−0.4) лучше,
    // чем у T1_BAD (+0.4), но ОТНОСИТЕЛЬНО СВОЕГО ТИРА он хуже — ради
    // этого различения центрирование и делается.
    expect(stats.tierMean(5)).toBeCloseTo(-1.2);
    expect(stats.stat('T5_BAD')?.residual).toBeCloseTo(0.8);
  });

  it('очки положительны у карты лучше средней по своему тиру', () => {
    expect(statGainOf(stats.stat('T1_GOOD'), 10)).toBeCloseTo(0.7);
    expect(statGainOf(stats.stat('T1_BAD'), 10)).toBeCloseTo(-0.7);
    expect(statGainOf(stats.stat('T5_GOOD'), 10)).toBeCloseTo(0.8);
  });

  it('кап не даёт одиночной карте перевесить всё остальное', () => {
    expect(statGainOf(stats.stat('T5_GOOD'), 0.5)).toBeCloseTo(0.5);
    expect(statGainOf(stats.stat('T5_BAD'), 0.5)).toBeCloseTo(-0.5);
  });

  it('без записи — честный ноль, а не выдуманное число', () => {
    expect(statGainOf(null, 1)).toBe(0);
    // Золотая копия к базовой НЕ приводится: золотых в источнике нет вовсе.
    expect(stats.stat('T1_GOOD_G')).toBeNull();
  });

  it('пустой снапшот не роняет разбор', () => {
    expect(createCardStats(null, cards).size).toBe(0);
    expect(createCardStats({ cardStats: [] }, cards).size).toBe(0);
  });
});
