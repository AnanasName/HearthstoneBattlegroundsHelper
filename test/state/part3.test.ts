import { describe, expect, it } from 'vitest';

import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part3Game } from '../fixtures.js';

/**
 * Сверка с data/fixtures/part3/part3.expected.json — точками, проверенными
 * по скриншотам из data/screenshots/.
 *
 * Скриншоты сняты в середине фазы таверны, а состояние здесь берётся на её
 * конец, поэтому отдельные значения здоровья отличаются на единицу: между
 * кадром и концом фазы миньон успевал получить баф. Проверяется то, что
 * от момента не зависит — состав, порядок, атака, золото, тир.
 */

/** Последнее состояние каждой фазы — то же, что печатает demo:phase1. */
function endOfPhaseStates(): GameState[] {
  const text = part3Game();
  const reducer = createReducer(readPlayers(text));
  const out: GameState[] = [];
  let lastKey = '';
  let pending: GameState | null = null;

  for (const event of readPowerEvents(text)) {
    reducer.step(event);
    const s = reducer.snapshot();
    const key = `${String(s.turn)}|${s.phase}`;
    if (key !== lastKey) {
      if (pending !== null) out.push(pending);
      lastKey = key;
    }
    pending = s;
  }
  if (pending !== null) out.push(pending);
  return out;
}

describe('партия 3, сверка со скриншотами', () => {
  const states = endOfPhaseStates();
  const final = reduceLog(part3Game());

  it('финальное место 8 — на экране «8-е место!»', () => {
    expect(final.finalPlace).toBe(8);
    expect(final.phase).toBe('gameOver');
  });

  it('герой опознан', () => {
    expect(final.hero?.cardId).toBe('TB_BaconShop_HERO_60');
    expect(final.hero?.entityId).toBe(93);
  });

  it('игрок опознан, PlayerID отличается от партии 2', () => {
    expect(final.playerBattleTag).toBe('AngryMem#2886');
    // В партии 2 тот же игрок шёл под PlayerID=4 — номер не постоянен,
    // и опознание по нему было бы ошибкой.
    expect(final.playerId).toBe(3);
  });

  it('ход 7: борд и магазин совпадают с кадром fourth_turn.png', () => {
    const s = states.find((x) => x.turn === 7 && x.phase === 'tavern');
    expect(s).toBeDefined();

    expect(s?.board.map((m) => m.attack)).toEqual([1, 4, 3, 2, 3, 2]);
    expect(s?.board.map((m) => m.zonePos)).toEqual([1, 2, 3, 4, 5, 6]);

    // Магазин на кадре: 2/3, 5/1, 3/5 — совпал в точности.
    expect(s?.shop.map((m) => `${String(m.attack)}/${String(m.health)}`)).toEqual([
      '2/3',
      '5/1',
      '3/5',
    ]);

    expect(s?.gold).toBe(0);
    expect(s?.goldTotal).toBe(6);
    expect(s?.hero?.health).toBe(30);
    expect(s?.hero?.armor).toBe(7);
  });

  it('поздний борд совпадает с кадром eigth_turn.png', () => {
    // 55/55, 8/3, 13/2x, 12/12, 6/6, 13/15 при золоте 0/10 и тире 5.
    const s = states.find(
      (x) => x.goldTotal === 10 && x.techLevel === 5 && x.board.length === 6,
    );
    expect(s).toBeDefined();

    expect(s?.board.map((m) => m.attack)).toEqual([55, 8, 13, 12, 6, 13]);
    expect(s?.gold).toBe(0);
  });

  it('золото — это остаток, а не выданное на ход', () => {
    // Ошибка, найденная скриншотами: показывалось RESOURCES вместо остатка.
    for (const s of states) {
      expect(s.gold).toBe(Math.max(0, s.goldTotal - s.goldSpent));
      expect(s.gold).toBeLessThanOrEqual(s.goldTotal);
    }
  });

  it('борд нигде не длиннее семи, магазин и борд противника не пересекаются', () => {
    for (const s of states) {
      expect(s.board.length).toBeLessThanOrEqual(7);
      expect(s.shop.length > 0 && s.opponentBoard.length > 0).toBe(false);
    }
  });
});
