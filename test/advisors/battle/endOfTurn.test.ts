import { describe, expect, it } from 'vitest';

import type { AllCardsService } from '@firestone-hs/reference-data';

import {
  endOfTurnAuraGains,
  withEndOfTurnAuras,
} from '../../../src/advisors/battle/endOfTurn.js';
import { minion } from '../../minions.js';

/**
 * Баффы «соседям» конца хода — part16, Surfing Sylvar.
 *
 * Порядок фаз: таверна → конец хода → бой, поэтому бафф применяется
 * к каждому кандидату расстановки перед симуляцией — и польза центра
 * входит в счёт боя сама, без выдуманных весов.
 */

const SYLVAR_TEXT =
  '[x]At the end of your turn, give adjacent minions +{0} Attack. Repeat for each friendly Golden minion.';

function fakeCards(textByCardId: Record<string, string>): AllCardsService {
  return {
    getCard: (id: string) => ({ text: textByCardId[id] }),
  } as unknown as AllCardsService;
}

describe('баффы соседям конца хода', () => {
  const cards = fakeCards({ SYLVAR: SYLVAR_TEXT, PLAIN: 'Just a body.' });

  it('носитель находится по тексту, величина — из живого плейсхолдера', () => {
    const board = [
      minion(1, { cardId: 'PLAIN' }),
      minion(2, { cardId: 'SYLVAR', scriptData: [1, null, null, null, null, null] }),
      minion(3, { cardId: 'PLAIN' }),
    ];
    const gains = endOfTurnAuraGains(board, cards);
    expect(gains.get(2)).toBe(1);
    expect(gains.has(1)).toBe(false);
  });

  it('повторы за золотых: «Repeat for each friendly Golden minion»', () => {
    const board = [
      minion(1, { cardId: 'PLAIN', golden: true }),
      minion(2, { cardId: 'SYLVAR', scriptData: [1, null, null, null, null, null] }),
      minion(3, { cardId: 'PLAIN' }),
    ];
    // Раз базово плюс раз за золотого: каждому соседу +2.
    expect(endOfTurnAuraGains(board, cards).get(2)).toBe(2);
  });

  it('бафф достаётся соседям по ПОРЯДКУ: в центре — обоим, с краю — одному', () => {
    const sylvar = minion(2, { cardId: 'SYLVAR', scriptData: [1, null, null, null, null, null] });
    const a = minion(1, { cardId: 'PLAIN', attack: 5 });
    const b = minion(3, { cardId: 'PLAIN', attack: 5 });
    const gains = endOfTurnAuraGains([a, sylvar, b], cards);

    const center = withEndOfTurnAuras([a, sylvar, b], gains);
    expect(center.map((m) => m.attack)).toEqual([6, 3, 6]);

    const edge = withEndOfTurnAuras([sylvar, a, b], gains);
    expect(edge.map((m) => m.attack)).toEqual([3, 6, 5]);

    // Вход не мутируется: кандидатов тысячи, и они делят одни объекты.
    expect(a.attack).toBe(5);
    expect(b.attack).toBe(5);
  });

  it('без носителей вход возвращается как есть, без копирования', () => {
    const board = [minion(1, { cardId: 'PLAIN' })];
    const gains = endOfTurnAuraGains(board, cards);
    expect(withEndOfTurnAuras(board, gains)).toBe(board);
  });
});
