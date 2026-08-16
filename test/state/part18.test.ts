import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, minionValue, sellForGoldRule } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part18Game } from '../fixtures.js';

/**
 * part18 — десятая партия с оверлеем (16.08.2026, наги на заклинаниях,
 * 4-е место) и первая с ПЛАНОМ ТРАТ ХОДА. Все три пункта обратной связи —
 * про план: он не видел продажи экономической карты, тратил остаток
 * на раннее обновление и вёл в композицию чужую карту.
 *
 * Контрольные значения — `part18.expected.json`, три скриншота из чата.
 */
describe('part18: продажа в план, раннее обновление, синергия по механике', () => {
  let cards: CardIndex;

  let turn5: GameState | null = null;
  let turn7: GameState | null = null;
  let turn17: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part18Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const { content } = event.line;
      if (!content.includes('ZONE') && !content.includes('RESOURCES') && !content.includes('COST')) {
        continue;
      }
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;

      // Ход 5, момент скриншота: River Skipper на борде, Mini-Myrmidon в руке.
      if (s.turn === 5 && s.gold === 5 && s.board.length === 1 && s.hand.length === 1) turn5 = s;
      // Ход 7: цена подъёма уже упала до 5 — то, что видел игрок.
      if (s.turn === 7 && s.gold === 6 && s.tavernUpgradeCost === 5) turn7 = s;
      if (s.turn === 17 && s.gold === 6 && s.board.length === 7) turn17 = s;
    }
    finalState = reducer.snapshot();
  }, 240_000);

  it('партия дочитывается до конца: 4-е место, билд из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(4);
    expect(finalState.hero?.cardId).toBe('BG30_HERO_304');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('ход 5: продажа экономической карты входит в план (пункт 1)', () => {
    // River Skipper 1/1 — «When you sell this, get a random Tier 1 minion»:
    // обещанное отдаётся только при продаже, а шестое золото открывает
    // вторую трату. План раскладывал пять золотых, не видя этого.
    expect(turn5).not.toBeNull();
    if (turn5 === null) return;

    expect(turn5.board.map((m) => m.cardId)).toEqual(['BG33_140']);
    expect(turn5.gold).toBe(5);

    const sell = sellForGoldRule(turn5, { cards });
    expect(sell?.action).toBe('sell');
    expect(sell?.minion?.cardId).toBe('BG33_140');
    expect(sell?.reason).toContain('только при продаже');

    const plan = spendPlan(turn5, { cards });
    expect(plan.steps.some((s) => s.recommendation.action === 'sell')).toBe(true);
    // Золото уходит целиком: ради этого продажа и делается.
    expect(plan.goldLeft).toBe(0);
  });

  it('ход 7: в ранней партии план не тратит остаток на обновление (пункт 2)', () => {
    // Подъём за 5 из 6 золотых, остаётся 1. Прежний план тратил его
    // на обновление: после подъёма кнопки уже нет, и запрет раннего реролла
    // (он привязан к доступному подъёму) переставал действовать.
    expect(turn7).not.toBeNull();
    if (turn7 === null) return;

    expect(turn7.gold).toBe(6);
    expect(turn7.tavernUpgradeCost).toBe(5);

    const plan = spendPlan(turn7, { cards });
    expect(plan.steps.some((s) => s.recommendation.action === 'levelUp')).toBe(true);
    expect(plan.steps.some((s) => s.recommendation.action === 'reroll')).toBe(false);
    expect(plan.goldLeft).toBe(1);
  });

  it('ход 17: нага со Spellcraft обходит демона на борде заклинаний (пункт 3)', () => {
    // Борд наг живёт заклинаниями: Abyssal Bruiser считает «Tavern spells
    // you've cast», Fleeing Fugitive растёт от «cast a spell on this».
    // Deep-Sea Angler НЕСЁТ Spellcraft — он и есть источник этих заклинаний,
    // но связь читалась только в обратную сторону, и советник вёл к демону
    // на два тира выше.
    expect(turn17).not.toBeNull();
    if (turn17 === null) return;

    expect(turn17.shop.map((m) => m.cardId)).toEqual(
      expect.arrayContaining(['BG23_004', 'BG32_873']),
    );

    const angler = turn17.shop.find((m) => m.cardId === 'BG23_004');
    const demon = turn17.shop.find((m) => m.cardId === 'BG32_873');
    expect(angler).toBeDefined();
    expect(demon).toBeDefined();
    if (angler === undefined || demon === undefined) return;

    const anglerValue = minionValue(angler, turn17, { cards });
    expect(anglerValue.textMechMates).toBeGreaterThanOrEqual(2);
    expect(anglerValue.total).toBeGreaterThan(minionValue(demon, turn17, { cards }).total);

    const topBuy = adviseTavern(turn17, { cards })?.recommendations.find((r) => r.action === 'buy');
    expect(topBuy?.minion?.cardId).toBe('BG23_004');
  });
});
