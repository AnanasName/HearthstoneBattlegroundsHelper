import { describe, expect, it } from 'vitest';

import { splitLogLines } from '../../src/parser/logLine.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part1Segment } from '../fixtures.js';

/**
 * part1 — партия через четыре реконнекта: клиент перезапускался посреди игры,
 * и каждый сегмент после первого начинается с полного дампа состояния.
 * До сих пор здесь проверялась только структура лога; эти тесты проверяют
 * СОСТОЯНИЕ — что дампы переподключения восстанавливают партию, а не
 * начинают её заново.
 *
 * Контрольные значения — из `part1.expected.json`: ходы и тиры сегментов
 * записаны при разметке фикстуры, финал подтверждён человеком.
 */
describe('part1: состояние через четыре реконнекта', () => {
  const reduce = (text: string): GameState => {
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    return reducer.snapshot();
  };

  // Ходы сегментов — из expected.json; СВОЙ тир — наблюдение состояния
  // (в expected.json maxTechLevel — максимум по всему логу, то есть по всем
  // игрокам: свой игрок в сегментах 1–2 отставал от лидера на тир).
  it.each([
    { segment: 1 as const, maxTurn: 11, selfTier: 4 },
    { segment: 2 as const, maxTurn: 17, selfTier: 5 },
    { segment: 3 as const, maxTurn: 21, selfTier: 6 },
    { segment: 4 as const, maxTurn: 24, selfTier: 6 },
  ])(
    'сегмент $segment доигрывается до хода $maxTurn со своим тиром $selfTier',
    ({ segment, maxTurn, selfTier }) => {
      const state = reduce(part1Segment(segment));

      expect(state.turn).toBe(maxTurn);
      expect(state.techLevel).toBe(selfTier);
      // Свой игрок и герой определяются в каждом сегменте, включая начатые
      // с дампа переподключения, — раньше сегменты 2–4 жили без героя.
      expect(state.playerBattleTag).toBe('AngryMem#2886');
      expect(state.hero?.cardId).toBe('BG22_HERO_201_SKIN_D');
      expect(state.board.length).toBeGreaterThan(0);
    },
  );

  it('финал: Фаэлин, 4-е место (подтверждено человеком)', () => {
    const state = reduce(part1Segment(4));

    expect(state.phase).toBe('gameOver');
    expect(state.hero?.cardId).toBe('BG22_HERO_201_SKIN_D');
    expect(state.hero?.entityId).toBe(104);
    expect(state.finalPlace).toBe(4);
  });

  it('дамп переподключения восстанавливает партию с первых строк', () => {
    // Сегмент 2 начинается не с CREATE_GAME, а с полного дампа
    // (DebugPrintPowerList Count=177): середина партии должна быть видна
    // сразу, без ожидания «живых» событий. Помощник, запущенный после
    // переподключения, иначе молчал бы до первой перемены в игре.
    const lines = splitLogLines(part1Segment(2)).slice(0, 4000);
    const state = reduce(lines.join('\n'));

    expect(state.hero?.cardId).toBe('BG22_HERO_201_SKIN_D');
    // Дамп несёт состояние НА МОМЕНТ разрыва: ход после 11-го, тир 4 —
    // пятый игрок поднимет позже по сегменту.
    expect(state.turn).toBeGreaterThanOrEqual(11);
    expect(state.techLevel).toBe(4);
    expect(state.board.length).toBeGreaterThan(0);
  });
});
