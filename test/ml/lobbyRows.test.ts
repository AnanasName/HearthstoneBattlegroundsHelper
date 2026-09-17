import { describe, expect, it } from 'vitest';

import type { DatasetGame } from '../../src/ml/dataset.js';
import {
  LOBBY_FEATURE_NAMES,
  lobbyOutcomes,
  relativeFeaturesOfPlayer,
  toLobbyMlGame,
} from '../../src/ml/lobbyRows.js';
import { extractRelativeFeatures } from '../../src/ml/relativeFeatures.js';
import { EMPTY_STATE, type GameState, type Hero, type LobbyPlayer } from '../../src/state/types.js';

/**
 * Соперники из таблицы лобби — замер 6а (docs/ml.md). Тесты держат то,
 * что входит в предрегистрацию: как выводится исход соперника, когда
 * партия выпадает, что строка соперника считается ровно как наша
 * и что в строки попадают только живые на этой точке.
 */

const ME = 3;

function hero(hp: number): Hero {
  return {
    entityId: 64,
    cardId: 'H',
    health: hp,
    damage: 0,
    armor: 0,
    heroPowerCardId: null,
    heroPowerEntityId: null,
    heroPowerCost: null,
    heroPowerUsedThisTurn: false,
    heroPowerUnplayable: false,
    heroPowerLocked: false,
    heroPowerHasActivate: false,
    heroPowerExhausted: null,
    heroPowerDisabled: false,
    heroPowerScriptData: [],
  };
}

function player(playerId: number, hp: number, place: number, techLevel = 3): LobbyPlayer {
  return { playerId, heroCardId: 'H', health: 30, damage: 30 - hp, armor: 0, techLevel, place };
}

/** Состояние, в котором своя строка таблицы совпадает с героем и тиром — как в датасете. */
function stateOf(turn: number, players: readonly LobbyPlayer[]): GameState {
  const me = players.find((p) => p.playerId === ME);
  const hp = me === undefined ? 30 : 30 - me.damage;
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn,
    playerId: ME,
    hero: hero(hp),
    techLevel: me?.techLevel ?? 1,
    finalPlace: me?.place ?? null,
    lobby: Object.fromEntries(players.map((p) => [p.playerId, p])),
  };
}

function gameOf(finalPlace: number, states: readonly GameState[]): DatasetGame {
  return {
    fileName: 'g.json',
    finalPlace,
    record: {
      savedAt: '2026-09-17T00:00:00.000Z',
      buildNumber: 251952,
      heroCardId: 'H',
      finalPlace,
      checkpoints: states.map((state) => ({ turn: state.turn, state })),
    },
  };
}

/**
 * Последняя точка партии, где мы займём 4-е место: выбыли игроки 8, 7
 * (места 8 и 6) и игрок 6 (место 7); живы мы, 1, 2, 4 и 5. Свободных мест
 * у четверых живых соперников — 1, 2, 3, 5.
 */
const LAST = [
  player(1, 20, 1),
  player(2, 15, 2),
  player(ME, 5, 4, 5),
  player(4, 12, 3),
  player(5, 3, 5),
  player(6, 0, 7),
  player(7, -4, 6),
  player(8, 0, 8),
];

describe('исход соперника по последней точке', () => {
  it('выбывший — точное место, живой — среднее оставшихся мест', () => {
    const r = lobbyOutcomes(gameOf(4, [stateOf(21, LAST)]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcomes.get(6)).toEqual({ playerId: 6, place: 7, exact: true });
    expect(r.outcomes.get(7)).toEqual({ playerId: 7, place: 6, exact: true });
    expect(r.outcomes.get(8)).toEqual({ playerId: 8, place: 8, exact: true });
    for (const id of [1, 2, 4, 5]) {
      expect(r.outcomes.get(id)).toEqual({ playerId: id, place: (1 + 2 + 3 + 5) / 4, exact: false });
    }
    expect(r.outcomes.has(ME)).toBe(false);
  });

  it('группа из одного живого — снова точное место', () => {
    // Мы вторые: единственный живой соперник — первый.
    const players = [
      player(1, 9, 1),
      player(ME, 4, 2),
      ...[2, 4, 5, 6, 7, 8].map((id, i) => player(id, 0, 3 + i)),
    ];
    const r = lobbyOutcomes(gameOf(2, [stateOf(25, players)]));
    expect(r.ok && r.outcomes.get(1)).toEqual({ playerId: 1, place: 1, exact: true });
  });

  it('партия выпадает, если таблица неполна или места не сходятся', () => {
    const fail = (finalPlace: number, players: readonly LobbyPlayer[]): string => {
      const r = lobbyOutcomes(gameOf(finalPlace, [stateOf(21, players)]));
      return r.ok ? 'ok' : r.reason;
    };
    expect(fail(4, LAST.slice(0, 7))).toMatch(/7 игроков/);
    expect(fail(4, LAST.filter((p) => p.playerId !== ME).concat(player(9, 5, 4)))).toMatch(/своего игрока/);
    // Наше место среди мест выбывших раньше нас.
    expect(fail(7, LAST)).toMatch(/среди мест выбывших/);
    // Два выбывших на одном месте.
    expect(fail(4, LAST.map((p) => (p.playerId === 7 ? { ...p, place: 8 } : p)))).toMatch(/снимок до пересчёта/);
    // Здоровье соперника не прочитано — жив он или нет, не сказать.
    expect(fail(4, LAST.map((p) => (p.playerId === 5 ? { ...p, health: null } : p)))).toMatch(/здоровье/);
  });

  it('снимок до пересчёта мест выпадает, даже если места выбывших хуже нашего', () => {
    // Выбывший игрок 7 ещё стоит пятым, а живой игрок 5 — шестым: места
    // выбывших 5, 7, 8 все хуже нашего 4-го, но это не нижние три места.
    const stale = LAST.map((p) =>
      p.playerId === 7 ? { ...p, place: 5 } : p.playerId === 5 ? { ...p, place: 6 } : p,
    );
    const r = lobbyOutcomes(gameOf(4, [stateOf(21, stale)]));
    expect(r.ok ? 'ok' : r.reason).toMatch(/не нижние 3/);
  });

  it('подставное место владельца для контроля: исходы доживших следуют за ним', () => {
    const r = lobbyOutcomes(gameOf(4, [stateOf(21, LAST)]), { ownerPlace: 1 });
    expect(r.ok && r.outcomes.get(1)?.place).toBe((2 + 3 + 4 + 5) / 4);
    // Выбывшие не зависят от места владельца.
    expect(r.ok && r.outcomes.get(8)?.place).toBe(8);
    const g = toLobbyMlGame(gameOf(4, [stateOf(21, LAST)]), { ownerPlace: 1 });
    expect(g.ok && g.game.finalPlace).toBe(1);
    expect(g.ok && g.game.extraYs?.[0]).toBe(3.5);
  });

  it('вторичная ветка раздаёт места доживших по текущему месту', () => {
    const r = lobbyOutcomes(gameOf(4, [stateOf(21, LAST)]), { survivors: 'currentOrder' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Живые 1, 2, 4, 5 стоят 1-м, 2-м, 3-м и 5-м; свободны места 1, 2, 3, 5.
    expect([1, 2, 4, 5].map((id) => r.outcomes.get(id)?.place)).toEqual([1, 2, 3, 5]);
    expect(r.outcomes.get(1)?.exact).toBe(false);
  });
});

describe('признаки со стороны любого игрока', () => {
  it('у владельца записи совпадают с признаками замера 3', () => {
    const s = stateOf(21, LAST);
    expect(relativeFeaturesOfPlayer(s, ME)).toEqual(extractRelativeFeatures(s));
  });

  it('у соперника — те же пять чисел с его стороны, выбывшие не в счёт', () => {
    const s = stateOf(21, LAST);
    // Игрок 2: hp 15, тир 3, место 2. Живые кроме него: 1 (20), мы (5),
    // 4 (12), 5 (3) — средний hp 10, средний тир (3 + 5 + 3 + 3) / 4.
    expect(relativeFeaturesOfPlayer(s, 2)).toEqual([2, 5, 15 - 10, 3 - 14 / 4, (2 - 1) / (5 - 1)]);
  });
});

describe('партия для модели на всех восьми', () => {
  const early = stateOf(15, [
    player(1, 25, 1),
    player(2, 20, 2),
    player(ME, 18, 3, 4),
    player(4, 16, 4),
    player(5, 14, 5),
    player(6, 10, 6),
    player(7, 6, 7),
    player(8, 0, 8),
  ]);
  const game = gameOf(4, [early, stateOf(21, LAST)]);

  it('свои строки — признаки замера 3 с индикатором 1, соперники — живые на точке с индикатором 0', () => {
    const r = toLobbyMlGame(game);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const g = r.game;
    expect(g.rows).toEqual([
      [...extractRelativeFeatures(early), 1],
      [...extractRelativeFeatures(stateOf(21, LAST)), 1],
    ]);
    expect(g.rows[0]).toHaveLength(LOBBY_FEATURE_NAMES.length);
    // Ход 15: живы шесть соперников (игрок 8 уже выбыл); ход 21 — четверо.
    expect(g.extraRows).toHaveLength(6 + 4);
    expect(g.extraRows?.every((row) => row[row.length - 1] === 0)).toBe(true);
    expect(g.extraTavernTurns).toEqual([...Array<number>(6).fill(8), ...Array<number>(4).fill(11)]);
    // Игрок 6 на ходу 15 жив, выбыл к концу — точное место 7.
    const i6 = 4;
    expect(g.extraRows?.[i6]).toEqual([...relativeFeaturesOfPlayer(early, 6), 0]);
    expect(g.extraYs?.[i6]).toBe(7);
    expect(g.extraExact[i6]).toBe(true);
    expect(g.extraCurrentPlaces[i6]).toBe(6);
    // Игрок 1 жив до конца — среднее группы.
    expect(g.extraYs?.[0]).toBe(11 / 4);
    expect(g.extraExact[0]).toBe(false);
  });

  it('ветка «только точные» оставляет одних выбывших к концу', () => {
    const r = toLobbyMlGame(game, { exactOnly: true });
    expect(r.ok && r.game.extraYs).toEqual([7, 6]);
  });
});
