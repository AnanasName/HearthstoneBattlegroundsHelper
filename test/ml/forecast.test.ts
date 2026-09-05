import { describe, expect, it } from 'vitest';

import { PlaceForecaster } from '../../src/ml/forecast.js';
import { forecastLine } from '../../src/ui/format.js';
import { fitPlaceModel, type PlaceModelSnapshot } from '../../src/ml/placeModel.js';
import type { DatasetGame } from '../../src/ml/dataset.js';
import type { DatasetRecord } from '../../src/dataset/recorder.js';
import { EMPTY_STATE, type GameState, type Hero, type LobbyPlayer } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Прогноз места в живом режиме: когда он говорит и когда молчит.
 *
 * Главное здесь — молчание. Строка «ожидаемое место» без стола, без модели
 * или в разгар боя — это число, которое игрок прочитает как знание, а мы
 * не измеряли (docs/ml.md). Правило одно на оверлей и терминал и потому
 * живёт в прогнозисте, а не в двух подачах.
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

function lobbyPlayer(playerId: number, damage: number): LobbyPlayer {
  return {
    playerId,
    heroCardId: 'H',
    health: 30,
    damage,
    armor: 0,
    techLevel: 2,
    place: playerId,
  };
}

function tavernPoint(turn: number, damage: number, patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn,
    techLevel: 3,
    playerId: 3,
    finalPlace: 3,
    goldTotal: 6,
    shop: board([201, 202, 203]),
    hero: { ...HERO, damage },
    lobby: { 1: lobbyPlayer(1, 5), 3: lobbyPlayer(3, damage), 5: lobbyPlayer(5, 20) },
    ...patch,
  };
}

function trainingGame(fileName: string, place: number): DatasetGame {
  const record: DatasetRecord = {
    savedAt: '2026-09-05T00:00:00.000Z',
    buildNumber: 250339,
    heroCardId: 'BG33_HERO_001',
    finalPlace: place,
    // Урон растёт по ходам и тем быстрее, чем хуже место: без разброса
    // ТЕМПА признаки по истории константны, веса у них выходят нулевые,
    // и тест «история меняет прогноз» проверял бы пустое место.
    checkpoints: [1, 3, 5].map((turn, i) => ({
      turn,
      state: tavernPoint(turn, place * i),
    })),
  };
  return { fileName, record, finalPlace: place };
}

const SNAPSHOT: PlaceModelSnapshot = fitPlaceModel(
  [1, 2, 3, 5, 6, 8].map((place, i) => trainingGame(`g${String(i)}.json`, place)),
  new Date('2026-09-05T12:00:00.000Z'),
);

describe('прогноз места в живом режиме', () => {
  it('говорит на точке решения и подписывает число ошибкой и выборкой', () => {
    const forecaster = new PlaceForecaster({ snapshot: SNAPSHOT });

    forecaster.update(tavernPoint(1, 0));
    const forecast = forecaster.current();

    expect(forecast).not.toBeNull();
    expect(forecast?.place).toBeGreaterThanOrEqual(1);
    expect(forecast?.place).toBeLessThanOrEqual(8);
    expect(forecast?.error).toBe(SNAPSHOT.maeModel);
    expect(forecast?.games).toBe(SNAPSHOT.games);
  });

  it('без снапшота модели молчит: свежая установка до ml:fit', () => {
    const forecaster = new PlaceForecaster({ snapshot: null });

    forecaster.update(tavernPoint(1, 0));

    expect(forecaster.current()).toBeNull();
  });

  it('без таблицы лобби молчит: относительные признаки на пустом столе — ложь', () => {
    const forecaster = new PlaceForecaster({ snapshot: SNAPSHOT });

    forecaster.update(tavernPoint(1, 0, { lobby: {} }));

    expect(forecaster.current()).toBeNull();
  });

  it('в бою молчит: место игрок читает с экрана игры', () => {
    const forecaster = new PlaceForecaster({ snapshot: SNAPSHOT });

    forecaster.update(tavernPoint(1, 0));
    expect(forecaster.current()).not.toBeNull();

    forecaster.update(tavernPoint(2, 0, { phase: 'combat' }));
    expect(forecaster.current()).toBeNull();
  });

  /**
   * Точка решения — состояние ДО первой траты золота, как у датасета:
   * накопитель у обоих один (`DecisionPoints`). Значит после покупки прогноз
   * считается по той же точке, а не по состоянию с потраченным золотом.
   */
  it('после траты золота держится точки решения этого хода', () => {
    const forecaster = new PlaceForecaster({ snapshot: SNAPSHOT });

    forecaster.update(tavernPoint(3, 4));
    const before = forecaster.current();
    forecaster.update(tavernPoint(3, 4, { goldSpent: 3, gold: 3 }));

    expect(forecaster.current()).toEqual(before);
  });

  /**
   * История копится по ходам: прогноз на третьем ходу считается по трём
   * точкам, а не по одной. Проверяется тем, что тот же ход при другой
   * предыстории даёт другое число.
   */
  it('копит историю партии: та же точка при разной предыстории читается иначе', () => {
    const steady = new PlaceForecaster({ snapshot: SNAPSHOT });
    steady.update(tavernPoint(1, 5));
    steady.update(tavernPoint(3, 6));
    steady.update(tavernPoint(5, 6));

    const falling = new PlaceForecaster({ snapshot: SNAPSHOT });
    falling.update(tavernPoint(1, 0));
    falling.update(tavernPoint(3, 2));
    falling.update(tavernPoint(5, 6));

    expect(steady.current()?.place).not.toBeCloseTo(falling.current()?.place ?? 0, 6);
  });

  /**
   * Подача терминала: три вещи в одной строке. Порознь они врут — число
   * без ошибки читается как знание, ошибка без выборки не даёт возразить,
   * а без слов «не совет» строка встаёт в один ряд с советами выше.
   */
  it('строка терминала называет число, ошибку, выборку и что это не совет', () => {
    const line = forecastLine({ place: 3.42, error: 1.689, games: 43 });

    expect(line).toContain('3.4');
    expect(line).toContain('± 1.7');
    expect(line).toContain('43');
    expect(line).toContain('не совет');
  });

  it('новая партия сбрасывает историю прошлой', () => {
    const forecaster = new PlaceForecaster({ snapshot: SNAPSHOT });
    forecaster.update(tavernPoint(1, 0));
    forecaster.update(tavernPoint(3, 8));

    forecaster.reset();
    expect(forecaster.current()).toBeNull();

    forecaster.update(tavernPoint(1, 0));
    const fresh = new PlaceForecaster({ snapshot: SNAPSHOT });
    fresh.update(tavernPoint(1, 0));

    expect(forecaster.current()).toEqual(fresh.current());
  });
});
