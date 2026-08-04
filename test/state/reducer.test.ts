import { describe, expect, it } from 'vitest';

import { readPlayers } from '../../src/state/players.js';
import { reduceLog } from '../../src/state/reducer.js';
import { part2Game } from '../fixtures.js';

/**
 * Сверка с data/fixtures/part2/part2.expected.json — теми точками,
 * которые подтвердил человек: герой Воришка Бигглсуорт, 5-е место,
 * аномалия «Ложные идолы», максимальный тир таверны 5.
 */
describe('readPlayers на эталонной партии', () => {
  it('опознаёт своего игрока по ненулевому GameAccountId', () => {
    const players = readPlayers(part2Game());

    expect(players.decls).toHaveLength(2);
    expect(players.decls.filter((d) => d.hasAccount)).toHaveLength(1);
    expect(players.selfPlayerId).toBe(4);
    expect(players.selfName).toBe('AngryMem#2886');
  });

  it('второй слот — системный, без аккаунта', () => {
    const players = readPlayers(part2Game());
    const other = players.decls.find((d) => !d.hasAccount);

    expect(other?.playerId).toBe(12);
    expect(players.names.get(12)).toBe('SilentStorm');
  });
});

describe('reduceLog на эталонной партии', () => {
  const state = reduceLog(part2Game());

  it('партия закончена', () => {
    expect(state.phase).toBe('gameOver');
  });

  it('находит своего героя через HERO_ENTITY, а не по cardId', () => {
    // cardId героя на концовке не уникален: под player=4 проходит служебный
    // двойник id=16441 с тем же cardId. HERO_ENTITY указывает на настоящего.
    expect(state.hero?.entityId).toBe(94);
    expect(state.hero?.cardId).toBe('TB_BaconShop_HERO_70_SKIN_H');
  });

  it('финальное место совпадает с подтверждённым человеком', () => {
    expect(state.finalPlace).toBe(5);
  });

  it('аномалия партии совпадает с подтверждённой человеком', () => {
    expect(state.anomalyCardId).toBe('BG27_Anomaly_301');
  });

  it('тир таверны дорос до 5', () => {
    expect(state.techLevel).toBe(5);
  });

  it('ход дошёл до 24', () => {
    expect(state.turn).toBe(24);
  });

  it('игрок опознан по BattleTag', () => {
    expect(state.playerBattleTag).toBe('AngryMem#2886');
    expect(state.playerId).toBe(4);
  });

  it('борд не больше семи миньонов — жёсткое правило Battlegrounds', () => {
    expect(state.board.length).toBeLessThanOrEqual(7);
  });

  it('у миньонов борда заполнены cardId и позиция', () => {
    for (const m of state.board) {
      expect(m.cardId).not.toBe('');
      expect(m.zonePos).toBeGreaterThanOrEqual(0);
    }
  });

  it('позиции борда идут по возрастанию', () => {
    const positions = state.board.map((m) => m.zonePos);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
