import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  freezeRule,
  heroPowerSpellRule,
  minionValue,
} from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part15Game } from '../fixtures.js';

/**
 * part15 — седьмая партия с оверлеем (14.08.2026, Доктор Холли'дэй,
 * 1-е место), пять пунктов обратной связи (`part15.expected.json`):
 * заморозка пары первого тира, молчание платной силы «даёт заклинание»,
 * продажа Titus Rivendare под Wolf Pup, цель у нецелевого заклинания,
 * провокация на Deathstrider.
 */
describe('part15: сила-заклинание, усилители механик, цели заклинаний', () => {
  let text: string;
  let cards: CardIndex;

  const reduceTo = (mark: string): GameState => {
    const cut = text.indexOf(mark);
    expect(cut, `метка ${mark} должна быть в логе`).toBeGreaterThan(0);
    const slice = text.slice(0, cut);
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  beforeAll(() => {
    text = part15Game();
    cards = loadCardIndex();
  }, 120_000);

  it('Холли\'дэй, 1-е место', () => {
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    const state = reducer.snapshot();
    expect(state.hero?.cardId).toBe('BG28_HERO_801');
    expect(state.finalPlace).toBe(1);
  });

  it('пара Buzzing Vermin первого тира витрину не держит (жалоба 1)', () => {
    // Конец хода 5 (золото 0): на борде один Buzzing Vermin, в витрине
    // второй, и прежний совет морозил витрину ради пары дешёвки.
    const state = reduceTo('D 20:22:36.2985502');
    expect(state.turn).toBe(5);
    expect(state.board.some((m) => m.cardId === 'BG31_803')).toBe(true);
    expect(state.shop.some((m) => m.cardId === 'BG31_803')).toBe(true);

    expect(freezeRule(state, { cards })).toBeNull();
  });

  it('сила «Get a random Tavern spell» за 1 советуется при остатке золота (жалоба 2)', () => {
    // Ход 7, золото 1: игрок нажал силу сам в 20:23:10 — срез прямо перед
    // нажатием. COST=1 и HAS_ACTIVATE_POWER подтверждены логом (id 166).
    const state = reduceTo('D 20:23:10.2083028');
    expect(state.gold).toBe(1);
    expect(state.hero?.heroPowerCardId).toBe('BG28_HERO_801p');
    expect(state.hero?.heroPowerCost).toBe(1);
    expect(state.hero?.heroPowerHasActivate).toBe(true);

    const rec = heroPowerSpellRule(state, { cards });
    expect(rec?.action).toBe('heroPower');
    expect(rec?.reason).toContain('заклинание таверны');

    const advice = adviseTavern(state, { cards, bgStats: null });
    expect(
      advice?.recommendations.some(
        (r) => r.action === 'heroPower' && r.reason.includes('заклинание таверны'),
      ),
    ).toBe(true);

    // После нажатия — молчание до конца хода.
    const after = reduceTo('D 20:24:01.6253578');
    expect(after.hero?.heroPowerUsedThisTurn).toBe(true);
    expect(heroPowerSpellRule(after, { cards })).toBeNull();
  });

  it('Titus Rivendare на борде хрипов не продаётся под Wolf Pup (жалоба 3)', () => {
    // Конец хода 17: борд полон (с Deathstrider), в руке Wolf Pup 3/5.
    // Titus 5/9 без племени был слабейшим по голым статам, и советник
    // предлагал продать усилитель хрипов ради ралли-волчонка.
    const state = reduceTo('D 20:34:52.4361189');
    expect(state.turn).toBe(17);
    const titus = state.board.find((m) => m.cardId === 'BG25_354');
    expect(titus).toBeDefined();
    expect(state.board.some((m) => m.cardId === 'BG36_208')).toBe(true);
    expect(state.hand.some((m) => m.cardId === 'BG36_207')).toBe(true);

    // Текст «Your Deathrattles trigger an extra time» теперь считается:
    // хрипы на борде — его ценность.
    if (titus !== undefined) {
      const rest = state.board.filter((m) => m.entityId !== titus.entityId);
      const value = minionValue(titus, { ...state, board: rest }, { cards });
      expect(value.textMechMates).toBeGreaterThanOrEqual(3);
    }

    const advice = adviseTavern(state, { cards, bgStats: null });
    expect(
      advice?.recommendations.some((r) => r.sellFirst?.cardId === 'BG25_354'),
    ).toBe(false);
  });

  it('Misplaced Tea Set советуется без цели: выбора у игрока нет (жалоба 4)', () => {
    // Ход 19, золото 2: «Give a friendly minion of each type +2/+2» —
    // игра раздаёт сама, а совет писал «→ на Deathstrider 18/11».
    const state = reduceTo('D 20:36:14.3485417');
    expect(state.turn).toBe(19);
    expect(state.gold).toBe(2);
    expect(state.shopSpells.some((s) => s.cardId === 'BG28_888')).toBe(true);

    const advice = adviseTavern(state, { cards, bgStats: null });
    const teaSet = advice?.recommendations.find((r) => r.spellCardId === 'BG28_888');
    expect(teaSet).toBeDefined();
    expect(teaSet?.targetMinion ?? null).toBeNull();
    expect(teaSet?.reason).toContain('не выбирается');
  });

  it('провокация Slimy Shield не целится в Deathstrider (жалоба 5)', () => {
    // Тот же срез: «Give a minion +1/+1 and Taunt» шёл «на Deathstrider
    // 18/11» — крупнейшего, но его ценность в триггере «After a friendly
    // Rally minion attacks…», и в приоритет ударов его ставить нельзя.
    const state = reduceTo('D 20:36:14.3485417');
    expect(state.handSpells.some((s) => s.cardId === 'BG27_002t')).toBe(true);

    const advice = adviseTavern(state, { cards, bgStats: null });
    const shield = advice?.recommendations.find((r) => r.spellCardId === 'BG27_002t');
    expect(shield).toBeDefined();
    expect(shield?.targetMinion?.cardId).not.toBe('BG36_208');
    expect(shield?.reason).toContain('провокация');
  });
});
