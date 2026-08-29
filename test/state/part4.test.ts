import { beforeAll, describe, expect, it } from 'vitest';

import { buyCostOf } from '../../src/advisors/tavern/advisor.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part4Game } from '../fixtures.js';

/**
 * part4 — партия билда 248348, которой калибруются предсказания. Здесь же
 * единственная в фикстурах ЧАСТИЧНАЯ скидка на покупку: в 00:25 два миньона
 * витрины получают `BACON_REDUCE_BUY_COST=2` (цена 1 вместо 3), остальные
 * остаются по три. Полная скидка (9999, миньоны даром) лежит в part3.
 */
describe('part4: скидка на покупку миньона', () => {
  let text: string;

  beforeAll(() => {
    text = part4Game();
  }, 120_000);

  const reduceTo = (mark: string): GameState => {
    const cut = text.indexOf(mark);
    expect(cut, `метка ${mark} должна быть в логе`).toBeGreaterThan(0);
    const slice = text.slice(0, cut);
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  it('скидка 2 видна на части витрины, и цена совета считается по ней', () => {
    // Срез перед сбросом тега (00:25:57): скидка ещё действует.
    const state = reduceTo('D 00:25:57.0938907');
    expect(state.phase).toBe('tavern');

    const discounted = state.shop.filter(
      (m) => (m.tags['BACON_REDUCE_BUY_COST'] ?? 0) > 0,
    );
    expect(discounted.length).toBeGreaterThan(0);
    for (const m of discounted) expect(buyCostOf(m)).toBe(1);

    // Скидка точечная, не на всю витрину: у остальных цена прежняя.
    const fullPrice = state.shop.filter((m) => (m.tags['BACON_REDUCE_BUY_COST'] ?? 0) === 0);
    expect(fullPrice.length).toBeGreaterThan(0);
    for (const m of fullPrice) expect(buyCostOf(m)).toBe(3);

    // Оба источника цены сходятся: кнопка `DragBuy` (живой `COST`, part35)
    // показывает то же, что тег скидки на миньоне, — 1 у скидочных, 3
    // у остальных. Сверка по всем снимкам таверны партии: 6824 согласий,
    // 2 расхождения — и оба на одном событии, где кнопка меняет цену
    // строкой РАНЬШЕ тега на миньоне (00:25:09, сущности 5922 и 5928).
    for (const m of discounted) expect(m.buyCost).toBe(1);
    for (const m of fullPrice) expect(m.buyCost).toBe(3);
  });
});
