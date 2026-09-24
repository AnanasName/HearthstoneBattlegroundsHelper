import { describe, expect, it } from 'vitest';

import { toBattleInfo, type BattleSetup } from '../../../src/advisors/battle/mapper.js';
import {
  EMPTY_GLOBAL_INFO,
  playersAlive,
  type Hero,
  type LobbyPlayer,
} from '../../../src/state/types.js';
import { minion } from '../../minions.js';

/**
 * Потолок урона (D288): симулятор умеет его сам (`damage-cap.js` пакета:
 * при пяти и больше живых — 5 на ходах таверны 1–3, 10 на 4–7, 15 дальше),
 * но включается он только двумя полями входа. Мы не передавали ни одного,
 * и «смерть в 2 % боёв» стояла на экране при запасе 28, который потолок 15
 * не пробивает (part72, кадр 19:45).
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'TB_BaconShop_HERO_08',
  health: 30,
  damage: 2,
  armor: 0,
  heroPowerCardId: 'TB_BaconShop_HP_069',
  heroPowerEntityId: 182,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerExhausted: null,
  heroPowerDisabled: false,
  heroPowerScriptData: [],
};

const lobbyPlayer = (playerId: number, patch: Partial<LobbyPlayer> = {}): LobbyPlayer => ({
  playerId,
  heroCardId: 'TB_BaconShop_HERO_PH',
  health: 30,
  damage: 0,
  armor: 0,
  techLevel: 3,
  place: playerId,
  ...patch,
});

const lobbyOf = (players: readonly LobbyPlayer[]): Record<number, LobbyPlayer> =>
  Object.fromEntries(players.map((p) => [p.playerId, p]));

describe('живые игроки лобби — вход потолка урона', () => {
  it('таблицы лобби нет — число неизвестно', () => {
    expect(playersAlive({ lobby: {} })).toBeNull();
  });

  it('выбыл тот, чей урон дошёл до здоровья, даже если броня осталась', () => {
    // part21, бой хода 22: лобби дословно. Игрок 6 сдался на ходу 13 —
    // HEALTH 30, DAMAGE 30, а ARMOR 5 игра не тронула, и запас с бронёй
    // показывал 5 до конца партии. Живых четверо, потолка нет, и урон
    // боя был 22 — счёт «запас с бронёй больше нуля» давал пятерых
    // и единственное на 873 боя корпуса «превышение» потолка.
    const lobby = lobbyOf([
      lobbyPlayer(1, { damage: 19 }),
      lobbyPlayer(2, { armor: 2 }),
      lobbyPlayer(3, { damage: 43 }),
      lobbyPlayer(4, { damage: 6, armor: 5 }),
      lobbyPlayer(5, { damage: 30 }),
      lobbyPlayer(6, { damage: 30, armor: 5 }),
      lobbyPlayer(7, { damage: 23 }),
      lobbyPlayer(8, { damage: 39 }),
    ]);
    expect(playersAlive({ lobby })).toBe(4);
  });

  it('непрочитанное здоровье живым не считается', () => {
    // Ошибка в эту сторону безопасна: меньше пяти живых — потолка нет,
    // и смерть считается как до правки. В обратную — обещали бы «не умрёте»
    // там, где потолка на самом деле нет.
    const lobby = lobbyOf([
      lobbyPlayer(1),
      lobbyPlayer(2),
      lobbyPlayer(3),
      lobbyPlayer(4),
      lobbyPlayer(5, { health: null }),
    ]);
    expect(playersAlive({ lobby })).toBe(4);
  });
});

describe('потолок урона во входе симулятора', () => {
  const setup = (patch: Partial<BattleSetup> = {}): BattleSetup => ({
    turn: 17,
    playerBoard: [minion(1)],
    opponentBoard: [minion(2)],
    playerHero: HERO,
    techLevel: 5,
    anomalyCardId: null,
    globalInfo: EMPTY_GLOBAL_INFO,
    ...patch,
  });

  it('число живых известно — симулятор получает его вместе с включённым потолком', () => {
    const info = toBattleInfo(setup({ playersAlive: 8 }), 10);
    expect(info.gameState.numberOfPlayersAlive).toBe(8);
    expect(info.options.applyDamageCap).toBe(true);
    // Порог потолка пакет считает от `currentTurn`, а он в шкале таверны
    // (D286): ход партии 17 — девятый ход таверны, потолок 15.
    expect(info.gameState.currentTurn).toBe(9);
  });

  it('число живых неизвестно — потолка нет, как до правки', () => {
    for (const alive of [undefined, null]) {
      const info = toBattleInfo(setup({ playersAlive: alive }), 10);
      expect(info.gameState.numberOfPlayersAlive).toBeUndefined();
      expect(info.options.applyDamageCap).toBeUndefined();
    }
  });
});
