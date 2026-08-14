import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  choiceAdvice,
  freezeRule,
  playRules,
  spellRules,
} from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part10Game } from '../fixtures.js';

/**
 * part10 — вторая партия с работающим оверлеем (14.08.2026, билд 248348),
 * сыгранная сразу после правок по part9. Восемь скриншотов с советами стали
 * восемью пунктами обратной связи, каждый тест ниже — один из них.
 * Контрольные значения сверены со скриншотами из чата
 * (`part10.expected.json`, verifiedBy: скриншот из чата).
 *
 * Срезы режут лог по временным меткам моментов, когда игрок снимал экран:
 * состояние в тесте то же, что было у него на мониторе.
 */
describe('part10: заморозка, продажи на полном борде и заклинания', () => {
  let text: string;
  let cards: CardIndex;

  const reduceTo = (slice: string): GameState => {
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  const sliceAt = (mark: string): GameState => {
    const cut = text.indexOf(mark);
    expect(cut, `метка ${mark} должна быть в логе`).toBeGreaterThan(0);
    return reduceTo(text.slice(0, cut));
  };

  beforeAll(() => {
    text = part10Game();
    cards = loadCardIndex();
  }, 120_000);

  it('одна партия, 6-е место, заклинания руки видны состоянию', () => {
    const state = reduceTo(text);
    expect(state.playerBattleTag).toBe('AngryMem#2886');
    expect(state.finalPlace).toBe(6);
  });

  it('ход 3: золотая копия и амальгама больше не повод морозить (жалоба 1)', () => {
    // На борде золотая Aureate Laureate и амальгама, в витрине такая же
    // золотая; совет был «ЗАМОРОЗИТЬ» ради мнимых «своих по племени 2».
    const state = sliceAt('D 00:28:4');
    expect(state.turn).toBe(3);
    expect(state.board.some((m) => m.cardId === 'BG32_236' && m.golden)).toBe(true);
    expect(state.shop.some((m) => m.cardId === 'BG32_236')).toBe(true);
    expect(freezeRule(state, { cards })).toBeNull();
  });

  it('ход 5: монетка таверны превращает два золота в покупку (жалоба 2)', () => {
    // Совет был «НИЧЕГО» при 2 золотах и монетке в руке.
    const state = sliceAt('D 00:29:4');
    expect(state.turn).toBe(5);
    expect(state.gold).toBe(2);
    expect(state.handSpells.some((s) => s.cardId === 'BG28_810')).toBe(true);

    const coin = spellRules(state, { cards });
    expect(coin).toHaveLength(1);
    expect(coin[0]?.spellCardId).toBe('BG28_810');
    expect(coin[0]?.reason).toContain('откроется покупка');

    // И совет целиком ставит монетку выше «ничего».
    const advice = adviseTavern(state, { cards });
    expect(advice?.recommendations[0]?.spellCardId).toBe('BG28_810');
  });

  it('ход 7: подъём называет судьбу остатка (жалоба 3, уточнена в part11)', () => {
    const state = sliceAt('D 00:30:3');
    expect(state.turn).toBe(7);
    expect(state.gold).toBe(6);
    expect(state.tavernUpgradeCost).toBe(5);

    // Первая версия хвоста обещала остаток «на обновление» всегда; игрок
    // уточнил (part11, жалоба 4): рано реролл на сдачу — пустая трата,
    // и на втором тире остаток честно называется ценой подъёма.
    const advice = adviseTavern(state, { cards });
    const levelUp = advice?.recommendations.find((r) => r.action === 'levelUp');
    expect(levelUp?.reason).toContain('остаток 1 сгорит — это цена подъёма');
  });

  it('ход 9: бесплатная Тавматургия советуется с целью (жалоба 4)', () => {
    // Золото 0, в руке Тавматургия за 0 — прежний совет молчал, и статы
    // ближайшего боя пропадали.
    const state = sliceAt('D 00:32:2');
    expect(state.turn).toBe(9);
    expect(state.handSpells.some((s) => s.cardId === 'BG31_924t')).toBe(true);

    const spells = spellRules(state, { cards });
    const buff = spells.find((r) => r.spellCardId === 'BG31_924t');
    expect(buff).toBeDefined();
    expect(buff?.reason).toContain('усиление перед боем');
    expect(buff?.reason).toContain('цель');
  });

  it('ход 11: дракончик больше не продаёт такого же дракончика (жалоба 5)', () => {
    // Борд полон, слабейший — дракончик 2/3; в витрине такой же. Совет был
    // «купить/разыграть дракончика, продав дракончика».
    const state = sliceAt('D 00:33:57');
    expect(state.turn).toBe(11);
    expect(state.board.some((m) => m.cardId === 'BG29_810')).toBe(true);
    expect(state.shop.some((m) => m.cardId === 'BG29_810')).toBe(true);

    // Речь о покупке и розыгрыше: продажа легально называет дракончика
    // слабейшим ради явно лучшего кандидата, заморозка — второй копией.
    const advice = adviseTavern(state, { cards });
    const buys = (advice?.recommendations ?? []).filter(
      (r) => (r.action === 'buy' || r.action === 'play') && r.minion?.cardId === 'BG29_810',
    );
    expect(buys.length).toBeGreaterThan(0);
    for (const r of buys) {
      // Вторая копия — в руку под тройку, не через продажу.
      expect(r.sellFirst).toBeNull();
      expect(r.reason).toContain('в руку, под тройку');
    }
    for (const p of playRules(state, { cards })) {
      expect(p.sellFirst?.cardId).not.toBe('BG29_810');
    }
  });

  it('ход 13: вторая копия дешёвки на тире 4 витрину не держит (жалоба 7)', () => {
    // «ЗАМОРОЗИТЬ Snow Baller 3/4» при таверне 4: порог теперь растёт
    // с тиром, а амальгамы не изображают собираемое племя.
    const state = sliceAt('D 00:37:2');
    expect(state.turn).toBe(13);
    expect(state.techLevel).toBe(4);
    expect(state.shop.some((m) => m.cardId === 'BG31_818')).toBe(true);
    expect(freezeRule(state, { cards })).toBeNull();
  });

  it('ход 17: выбор из сокровищ-заклинаний получает рекомендацию (жалоба 8)', () => {
    // Три заклинания: бананы, «+{0} Attack и щит», скидка на заклинания.
    // Прежде весь выбор молчал, и оверлей советовал покупки поверх него.
    const state = sliceAt('D 00:40:0');
    expect(state.turn).toBe(17);
    expect(state.openChoice?.options.map((o) => o.cardId)).toEqual([
      'BGS_Treasures_019',
      'BGS_Treasures_015',
      'BGS_Treasures_104',
    ]);

    const advice = choiceAdvice(state, { cards });
    expect(advice[0]?.option.cardId).toBe('BGS_Treasures_015');
    expect(advice[0]?.score).not.toBeNull();
    expect(advice[0]?.reason).toContain('щит');
  });
});
