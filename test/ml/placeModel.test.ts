import { describe, expect, it } from 'vitest';

import type { DatasetGame } from '../../src/ml/dataset.js';
import type { DatasetRecord } from '../../src/dataset/recorder.js';
import { extractHistoryFeatures, HISTORY_FEATURE_NAMES } from '../../src/ml/historyFeatures.js';
import { fitPlaceModel, forecastPlace, usableForPlaceModel } from '../../src/ml/placeModel.js';
import { predictRidge } from '../../src/ml/ridge.js';
import { EMPTY_STATE, type GameState, type Hero, type LobbyPlayer } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Снапшот прогноза места: веса на всех точках, ошибка — из LOGO, молчание
 * без таблицы лобби. Право на строку в оверлее дал замер 4 (docs/ml.md,
 * «Перезамер 05.09.2026»), и продукт обязан считать ровно тем же прибором,
 * что замер, — иначе подпись «± 1.7» относится к другой модели.
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'BG33_HERO_001',
  health: 30,
  damage: 0,
  armor: 0,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

function lobbyPlayer(playerId: number, damage: number, techLevel: number): LobbyPlayer {
  return {
    playerId,
    heroCardId: 'H',
    health: 30,
    damage,
    armor: 0,
    techLevel,
    place: playerId,
  };
}

/** Точка решения: свой урон и тир против стола из трёх игроков. */
function point(turn: number, myDamage: number, tier: number, withLobby = true): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn,
    techLevel: tier,
    playerId: 3,
    finalPlace: 3,
    shop: board([201, 202, 203]),
    hero: { ...HERO, damage: myDamage },
    lobby: withLobby
      ? {
          1: lobbyPlayer(1, 5, 2),
          3: lobbyPlayer(3, myDamage, tier),
          5: lobbyPlayer(5, 20, 2),
        }
      : {},
  };
}

function game(
  fileName: string,
  finalPlace: number,
  points: readonly GameState[],
): DatasetGame {
  const record: DatasetRecord = {
    savedAt: '2026-09-05T00:00:00.000Z',
    buildNumber: 250339,
    heroCardId: 'BG33_HERO_001',
    finalPlace,
    checkpoints: points.map((state) => ({ turn: state.turn, state })),
  };
  return { fileName, record, finalPlace };
}

/** Шесть партий: LOGO требует пяти, обучение — хоть какого-то разброса мест. */
const GAMES: readonly DatasetGame[] = [1, 2, 3, 5, 6, 8].map((place, i) =>
  game(`g${String(i)}.json`, place, [
    point(1, 0, 1),
    point(3, place, 2),
    point(5, place * 2, 3),
  ]),
);

const NOW = new Date('2026-09-05T12:00:00.000Z');

describe('снапшот модели прогноза места', () => {
  it('паспорт называет выборку, признаки и билды', () => {
    const snapshot = fitPlaceModel(GAMES, NOW);

    expect(snapshot.features).toBe('history');
    expect(snapshot.featureNames).toEqual(HISTORY_FEATURE_NAMES);
    expect(snapshot.games).toBe(GAMES.length);
    expect(snapshot.points).toBe(GAMES.length * 3);
    expect(snapshot.builds).toEqual([250339]);
    expect(snapshot.fittedAt).toBe(NOW.toISOString());
    expect(snapshot.model.weights).toHaveLength(HISTORY_FEATURE_NAMES.length);
  });

  it('обучение детерминировано: два прогона дают те же веса', () => {
    expect(fitPlaceModel(GAMES, NOW)).toEqual(fitPlaceModel(GAMES, NOW));
  });

  /**
   * Ошибка на экране — из кросс-валидации, а не с обучающей выборки:
   * иначе прогноз обещал бы точность, которой у него на новой партии нет.
   * Проверяется тем, что число НЕ равно ошибке модели на своих же точках.
   */
  it('ошибка в паспорте — LOGO, а не подгонка под свою же выборку', () => {
    const snapshot = fitPlaceModel(GAMES, NOW);

    const own: number[] = [];
    for (const g of GAMES) {
      const states = g.record.checkpoints.map((c) => c.state);
      const errors = states.map((_, i) =>
        Math.abs(predictRidge(snapshot.model, extractHistoryFeatures(states[i] as GameState, i, states)) - g.finalPlace),
      );
      own.push(errors.reduce((a, b) => a + b, 0) / errors.length);
    }
    const inSample = own.reduce((a, b) => a + b, 0) / own.length;

    expect(snapshot.maeModel).toBeGreaterThan(inSample);
  });

  it('прогноз зажат в 1..8 местом, каким бы ни вышло число', () => {
    const snapshot = fitPlaceModel(GAMES, NOW);
    const states = [point(1, 0, 1), point(3, 25, 1), point(5, 29, 1)];

    const place = forecastPlace(snapshot, states, states.length - 1);

    expect(place).not.toBeNull();
    expect(place as number).toBeGreaterThanOrEqual(1);
    expect(place as number).toBeLessThanOrEqual(8);
  });

  /**
   * История партии в прогнозе ЕСТЬ: одна и та же точка при разной предыстории
   * даёт разное число. Иначе передача истории была бы декорацией, а модель
   * считала бы по нулевым признакам замера 4.
   */
  it('история точек меняет прогноз на той же последней точке', () => {
    const snapshot = fitPlaceModel(GAMES, NOW);
    const last = point(5, 20, 3);

    const steady = forecastPlace(snapshot, [point(1, 18, 3), point(3, 19, 3), last], 2);
    const falling = forecastPlace(snapshot, [point(1, 0, 3), point(3, 8, 3), last], 2);

    expect(steady).not.toBeNull();
    expect(falling).not.toBeNull();
    expect(steady).not.toBeCloseTo(falling as number, 6);
  });

  it('без таблицы лобби прогноз молчит, а партия не идёт в обучение', () => {
    const snapshot = fitPlaceModel(GAMES, NOW);
    const states = [point(1, 0, 1, false)];

    expect(forecastPlace(snapshot, states, 0)).toBeNull();
    expect(
      usableForPlaceModel([...GAMES, game('blind.json', 4, [point(1, 0, 1, false)])]),
    ).toHaveLength(GAMES.length);
  });
});
