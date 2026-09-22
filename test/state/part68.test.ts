import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, rerollRule } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES, tavernTurnOf } from '../../src/advisors/tavern/rules.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState } from '../../src/state/types.js';
import { frameAt, parseClock, sliceLogByClock } from '../../src/ui/logSlice.js';
import { part68Game } from '../fixtures.js';

/**
 * part68 — 22.09.2026, MC Scabbs, 2-е место. Фактура партии — в `test/fixtures.ts`.
 *
 * Жалоба игрока по кадру 21:46 дословно: «мне почему-то рекомендует обновить
 * таверну, хотя мне не хватит на покупку».
 *
 * Совет давало «обновление от безделья» (`adviseTavern`, оценка 0.5): лучший
 * совет — «ничего», а обновление ничего не стоит, значит можно искать лучшее.
 * Его пропускала проверка «не на что купить», потому что порогом ей служила
 * константа `cheapestShopPrice` — «самое дешёвое, что таверна продаёт вообще»,
 * то есть заклинание витрины за 1. Ровно на золоте 1 проверка говорила «есть
 * на что купить», и вместе с ней отключались ОБЕ защиты: и цель заморозки
 * (D025), и запрет тратить запасное обновление (D244) — а запас тут был 4.
 *
 * На самом кадре покупки не существовало: в витрине три миньона по 3 золота
 * и ни одного заклинания. Цена 1 — самая редкая в таверне: из 947 точек
 * решения датасета что-то не дороже 1 золота продавалось в 32% витрин,
 * на шестом тире — в 15%, тогда как не дороже 2 — в 77%.
 */
describe('part68: обновление при золоте, которого не хватит на покупку', () => {
  let cards: CardIndex;
  let state: GameState;

  beforeAll(() => {
    cards = loadCardIndex();
    const clock = parseClock('21:46:00');
    expect(clock).not.toBeNull();
    const slice = sliceLogByClock(part68Game(), clock!);
    expect(slice?.inGame).toBe(true);
    state = frameAt(slice!).state;
  }, 600_000);

  it('кадр воспроизводится: тир 6, золото 1, борд полон, запас обновлений 4', () => {
    // Числа с картинки игрока: «ход 29 · таверна · тир 6 · золото 1/10».
    expect(state.turn).toBe(29);
    expect(tavernTurnOf(state.turn)).toBe(15);
    expect(state.phase).toBe('tavern');
    expect(state.techLevel).toBe(6);
    expect(state.gold).toBe(1);
    expect(state.goldTotal).toBe(10);
    expect(state.board.length).toBe(DEFAULT_TAVERN_RULES.boardSize);

    // Обновление бесплатно только в золоте: цену в ноль уронил ЗАПАС,
    // а запас переживает смену хода (D244).
    expect(state.rerollCost).toBe(0);
    expect(state.freeRefreshes).toBe(4);
  });

  it('витрина на кадре не предлагает ничего дешевле трёх золотых', () => {
    // Три миньона по 3 и ни одного заклинания витрины: покупки на 1 золото
    // в этой витрине нет вовсе, и после обновления обещать её нечем.
    expect(state.shop.map((m) => m.buyCost)).toEqual([3, 3, 3]);
    expect(state.shopSpells).toEqual([]);
  });

  it('обновление молчит: купить на остаток нечего, а запас ждёт хода с золотом', () => {
    const advice = adviseTavern(state, { cards });
    expect(advice).not.toBeNull();

    // Ни первым советом, ни каким-либо ещё: обещать покупку нечем.
    expect(advice!.recommendations.some((r) => r.action === 'reroll')).toBe(false);
    expect(advice!.recommendations[0]?.action).toBe('pass');
    expect(rerollRule(state, { cards })).toBeNull();
  });

  it('снапшот знает все карты, которые патч показал в витринах', () => {
    // Проверка D136 числом — та же, что была на 250339: незнакомая карта
    // это не «чуть хуже совет», а совет вслепую (D135).
    const seen = [...state.seenShopCardIds];
    expect(seen.length).toBeGreaterThan(100);
    expect(seen.filter((id) => cards.info(id) === null)).toEqual([]);
  });
});
