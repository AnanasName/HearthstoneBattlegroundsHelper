import { describe, expect, it } from 'vitest';

import { MISSING_PLACE } from '../../src/ml/features.js';
import {
  extractRelativeFeatures,
  FULL_LOBBY,
  lobbyKnownInState,
  placeAmongAlive,
  RELATIVE_FEATURE_NAMES,
  RELATIVE_PLACE_INDEX,
} from '../../src/ml/relativeFeatures.js';
import { EMPTY_STATE, type GameState, type Hero, type LobbyPlayer } from '../../src/state/types.js';

/**
 * Относительные признаки замера 3 — предрегистрированный список
 * docs/ml.md. Тесты держат ПОРЯДОК, арифметику «против живых соперников»
 * и политику пропусков: всё это входит в предрегистрацию.
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'BG33_HERO_001',
  health: 30,
  damage: 5,
  armor: 15, // hp = 40
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

function player(
  playerId: number,
  patch: Partial<LobbyPlayer> = {},
): LobbyPlayer {
  return {
    playerId,
    heroCardId: 'H',
    health: 30,
    damage: 0,
    armor: 0,
    techLevel: 1,
    place: playerId,
    ...patch,
  };
}

function lobbyOf(players: readonly LobbyPlayer[]): Readonly<Record<number, LobbyPlayer>> {
  return Object.fromEntries(players.map((p) => [p.playerId, p]));
}

function state(patch: Partial<GameState>): GameState {
  return { ...EMPTY_STATE, phase: 'tavern', hero: HERO, playerId: 3, techLevel: 3, ...patch };
}

describe('относительные признаки места', () => {
  it('пять признаков, порядок совпадает с именами, место — первый', () => {
    // Я — игрок 3: hp 40, тир 3, место 2. Живые соперники: игрок 1
    // (hp 20, тир 2) и игрок 5 (hp 30, тир 4). Игрок 7 выбыл (урон
    // больше здоровья) — ни в живых, ни в средних.
    const s = state({
      finalPlace: 2,
      lobby: lobbyOf([
        player(1, { health: 30, damage: 10, techLevel: 2 }),
        player(3, { health: 30, damage: 5, armor: 15, techLevel: 3, place: 2 }),
        player(5, { health: 30, damage: 0, techLevel: 4 }),
        player(7, { health: 30, damage: 34, techLevel: 6, place: 8 }),
      ]),
    });
    const f = extractRelativeFeatures(s);
    expect(f).toHaveLength(RELATIVE_FEATURE_NAMES.length);
    expect(f[RELATIVE_PLACE_INDEX]).toBe(2);
    expect(f).toEqual([2, 3, 40 - (20 + 30) / 2, 3 - (2 + 4) / 2, (2 - 1) / (3 - 1)]);
  });

  it('соперник с непрочитанным тиром в средний тир не входит, в живых — входит', () => {
    const s = state({
      finalPlace: 1,
      lobby: lobbyOf([
        player(3, { health: 30, damage: 5, armor: 15, place: 1 }),
        player(4, { techLevel: null }),
        player(5, { techLevel: 5 }),
      ]),
    });
    const f = extractRelativeFeatures(s);
    expect(f[1]).toBe(3);
    expect(f[3]).toBe(3 - 5);
  });

  it('без таблицы лобби — живых восемь, разности ноль, место среди восьми', () => {
    const s = state({ finalPlace: 4, lobby: {} });
    expect(lobbyKnownInState(s)).toBe(false);
    expect(extractRelativeFeatures(s)).toEqual([4, FULL_LOBBY, 0, 0, 3 / 7]);
  });

  it('пропуск места — середина таблицы, как у замера 1', () => {
    const s = state({ finalPlace: null, lobby: lobbyOf([player(3), player(4)]) });
    expect(extractRelativeFeatures(s)[0]).toBe(MISSING_PLACE);
  });

  it('место среди живых зажато: выбывший, ещё стоящий выше живых, не даёт больше единицы', () => {
    // Снимок до пересчёта мест: живых двое, а моё место — 3.
    expect(placeAmongAlive(3, 2)).toBe(1);
    expect(placeAmongAlive(1, 1)).toBe(0);
    expect(placeAmongAlive(5, 8)).toBeCloseTo(4 / 7, 12);
  });

  it('без своего playerId соперники — все живые, включая себя', () => {
    const s = state({
      playerId: null,
      finalPlace: 1,
      lobby: lobbyOf([player(3, { armor: 10 }), player(4)]),
    });
    // Средний hp живых: (40 + 30) / 2 = 35, мой — 40.
    expect(extractRelativeFeatures(s)[2]).toBe(5);
  });
});
