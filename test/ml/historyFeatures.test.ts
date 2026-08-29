import { describe, expect, it } from 'vitest';

import {
  extractHistoryFeatures,
  HISTORY_FEATURE_NAMES,
  ownLossRate,
  rivalLossRate,
  timeToLive,
  ttlRankNorm,
  winShare,
} from '../../src/ml/historyFeatures.js';
import { RELATIVE_FEATURE_NAMES } from '../../src/ml/relativeFeatures.js';
import { EMPTY_STATE, type GameState, type Hero, type LobbyPlayer } from '../../src/state/types.js';

/**
 * Признаки по истории партии — предрегистрированный список замера 4.
 * Тесты держат порядок, оглядку на две точки, счёт боёв по ходам
 * таверны, ранг времени жизни с ничьими и запрет заглядывать в будущее.
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'BG33_HERO_001',
  health: 30,
  damage: 0,
  armor: 10, // hp = 40 при нулевом уроне
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

function player(playerId: number, damage: number, patch: Partial<LobbyPlayer> = {}): LobbyPlayer {
  return {
    playerId,
    heroCardId: 'H',
    health: 30,
    damage,
    armor: 0,
    techLevel: 2,
    place: playerId,
    ...patch,
  };
}

/** Точка: мой урон, урон соперников 1 и 5, результат прошлого боя. */
function point(
  turn: number,
  myDamage: number,
  rivalDamage: readonly [number, number],
  wonLastCombat: boolean | null = null,
): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn,
    techLevel: 3,
    playerId: 3,
    finalPlace: 2,
    wonLastCombat,
    hero: { ...HERO, damage: myDamage },
    lobby: {
      1: player(1, rivalDamage[0]),
      3: player(3, myDamage, { armor: 10 }),
      5: player(5, rivalDamage[1]),
    },
  };
}

// Ходы таверны 1, 2, 3, 4 (turn 1, 3, 5, 7): мой hp 40 → 40 → 30 → 10.
const SERIES: readonly GameState[] = [
  point(1, 0, [0, 0]),
  point(3, 0, [10, 0], true),
  point(5, 10, [20, 0], false),
  point(7, 30, [25, 0], true),
];

describe('признаки по истории партии', () => {
  it('восемь признаков: пять относительных и три по истории, в этом порядке', () => {
    expect(HISTORY_FEATURE_NAMES).toHaveLength(RELATIVE_FEATURE_NAMES.length + 3);
    expect(HISTORY_FEATURE_NAMES.slice(0, RELATIVE_FEATURE_NAMES.length)).toEqual(
      RELATIVE_FEATURE_NAMES,
    );
    const f = extractHistoryFeatures(SERIES[3] as GameState, 3, SERIES);
    expect(f).toHaveLength(HISTORY_FEATURE_NAMES.length);
    expect(f.slice(5)).toEqual([
      ownLossRate(SERIES, 3),
      ttlRankNorm(SERIES, 3),
      winShare(SERIES, 3),
    ]);
  });

  it('темп потерь смотрит на две точки назад и делит на число боёв по ходам таверны', () => {
    expect(ownLossRate(SERIES, 0)).toBe(0);
    // Вторая точка: один бой назад, hp 40 → 40.
    expect(ownLossRate(SERIES, 1)).toBe(0);
    // Третья: две точки назад (два боя), 40 → 30.
    expect(ownLossRate(SERIES, 2)).toBe(5);
    // Четвёртая: точки 1 → 3, hp 40 → 10 за два боя.
    expect(ownLossRate(SERIES, 3)).toBe(15);
  });

  it('пропуск точки в записи растягивает окно, а темп остаётся «за бой»', () => {
    // Точки на ходах таверны 1 и 4: между ними три боя, hp 40 → 10.
    const sparse = [point(1, 0, [0, 0]), point(7, 30, [0, 0])];
    expect(ownLossRate(sparse, 1)).toBe(10);
  });

  it('темп соперника — по таблице лобби в тех же точках; отсутствующий — null', () => {
    // Игрок 1: урон 10 → 25 между точками 1 и 3, два боя.
    expect(rivalLossRate(SERIES, 3, 1)).toBe(7.5);
    expect(rivalLossRate(SERIES, 3, 5)).toBe(0);
    expect(rivalLossRate(SERIES, 3, 8)).toBeNull();
  });

  it('время жизни: hp / темп, при темпе не выше нуля — бесконечность', () => {
    expect(timeToLive(30, 10)).toBe(3);
    expect(timeToLive(30, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(timeToLive(30, -5)).toBe(Number.POSITIVE_INFINITY);
  });

  it('ранг времени жизни: 0 — живу дольше всех, ничьи по половине, без истории 0.5', () => {
    // Точка 3: я — 10 hp при темпе 15 (0.67 боя); игрок 1 — 5 hp при
    // темпе 7.5 (0.67 боя) — ничья; игрок 5 — 30 hp без потерь — бесконечность.
    // Ранг = 1 + 1 (выше) + 0.5 (ничья) = 2.5 → (2.5 − 1) / (3 − 1) = 0.75.
    expect(ttlRankNorm(SERIES, 3)).toBeCloseTo(0.75, 12);
    // Первая точка: истории нет, у всех бесконечность — середина.
    expect(ttlRankNorm(SERIES, 0)).toBe(0.5);
    // Точка 2: я 30 hp при темпе 5 (6 боёв); игрок 1 — 10 hp при темпе 10
    // (1 бой); игрок 5 — бесконечность. Ранг 2 → 0.5.
    expect(ttlRankNorm(SERIES, 2)).toBe(0.5);
  });

  it('доля побед — выигранные точки на число боёв до точки; до первого боя 0', () => {
    expect(winShare(SERIES, 0)).toBe(0);
    expect(winShare(SERIES, 1)).toBe(1);
    expect(winShare(SERIES, 2)).toBe(0.5);
    expect(winShare(SERIES, 3)).toBeCloseTo(2 / 3, 12);
  });

  it('признаки точки не зависят от точек ПОСЛЕ неё', () => {
    const prefix = SERIES.slice(0, 3);
    expect(extractHistoryFeatures(SERIES[2] as GameState, 2, SERIES)).toEqual(
      extractHistoryFeatures(prefix[2] as GameState, 2, prefix),
    );
  });
});
