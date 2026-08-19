import { beforeAll, describe, expect, it } from 'vitest';

import { reduceLog } from '../../src/state/reducer.js';
import type { GameState, PlayerActionType } from '../../src/state/types.js';
import { part17Game } from '../fixtures.js';

/**
 * Журнал действий игрока — сырьё фазы 6: «какие действия ведут к победе»
 * не выучить, не записывая действий.
 *
 * Ожидаемые числа сняты с part17 НЕЗАВИСИМЫМ счётом по строкам лога
 * (канал GameState, блоки `BLOCK_START BlockType=PLAY` игрока 6):
 * 19 покупок миньонов + 9 заклинаний через `TB_BaconShop_DragBuy[_Spell]`,
 * 46 продаж через `TB_BaconShop_DragSell` (в двух целью стоит карта
 * с префиксом TB_ — «Продажементаль», жадный шаблон здесь однажды соврал),
 * 27 обновлений витрины, 4 подъёма таверны, 5 заморозок, 86 розыгрышей
 * из руки (zone=HAND в дескрипторе строки BLOCK_START), 12 активаций
 * миньонов на борде (BG36_180 и его золотая версия), 3 тёмных дара.
 */

let state: GameState;

beforeAll(() => {
  state = reduceLog(part17Game());
});

function ofType(type: PlayerActionType): readonly GameState['actions'][number][] {
  return state.actions.filter((a) => a.type === type);
}

describe('журнал действий (part17)', () => {
  it('счёт по типам совпадает с независимым счётом по строкам', () => {
    const counts = new Map<string, number>();
    for (const a of state.actions) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({
      buy: 28,
      sell: 46,
      roll: 27,
      levelUp: 4,
      freeze: 5,
      play: 86,
      activate: 12,
      darkGift: 3,
    });
  });

  it('первая покупка — Трескучий циклон на первом ходу, с картой-целью', () => {
    const firstBuy = ofType('buy')[0];
    expect(firstBuy?.turn).toBe(1);
    expect(firstBuy?.cardId).toBe('BGS_119');
    expect(firstBuy?.entityId).toBe(329);
  });

  it('купленный циклон тут же разыгран из руки', () => {
    const firstPlay = ofType('play')[0];
    expect(firstPlay?.turn).toBe(1);
    expect(firstPlay?.cardId).toBe('BGS_119');
  });

  it('покупка заклинания витрины идёт тем же типом buy (Зачарованное лассо)', () => {
    expect(ofType('buy').some((a) => a.cardId === 'BG28_512')).toBe(true);
  });

  it('продажа называет проданную карту (Терпеливый разведчик)', () => {
    expect(ofType('sell').some((a) => a.cardId === 'BG24_715')).toBe(true);
  });

  it('журнал идёт в порядке совершения: ходы не убывают', () => {
    const turns = state.actions.map((a) => a.turn);
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i]).toBeGreaterThanOrEqual(turns[i - 1] ?? 0);
    }
  });

  it('кнопки без карты-цели журналируются без cardId', () => {
    for (const type of ['roll', 'levelUp', 'freeze'] as const) {
      for (const a of ofType(type)) {
        expect(a.cardId).toBeNull();
      }
    }
  });
});
