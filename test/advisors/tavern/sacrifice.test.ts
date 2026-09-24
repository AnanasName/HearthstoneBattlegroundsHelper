import { describe, expect, it } from 'vitest';

import { buyRules, playRules, weakestOwn } from '../../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../../src/advisors/tavern/rules.js';
import { applyRecommendation } from '../../../src/advisors/tavern/spend.js';
import { createCardIndex } from '../../../src/data/cards.js';
import { EMPTY_STATE, type Enchantment, type GameState, type Minion } from '../../../src/state/types.js';
import { minion } from '../../minions.js';

/**
 * Тёмный дар при выборе жертвы — D292 (продажа) и D293 (клич-жертва),
 * part74. Карты подставные: правило читает текст, механики и племя,
 * а снапшот на 35 тысяч карт юнит-тесту не нужен.
 */
const STUB_CARDS = [
  {
    id: 'MAW',
    name: 'Пасть',
    type: 'Minion',
    techLevel: 4,
    races: ['UNDEAD'],
    isBaconPool: true,
    mechanics: ['BATTLECRY'],
    text: '<b>Battlecry:</b> Destroy a friendly Undead to <b>Discover</b> an Undead.',
  },
  {
    id: 'SKULL',
    name: 'Череп',
    type: 'Minion',
    techLevel: 2,
    attack: 2,
    health: 1,
    races: ['UNDEAD'],
    isBaconPool: true,
    mechanics: ['DEATHRATTLE', 'REBORN'],
    text: '<b>Reborn</b> <b>Deathrattle:</b> Give a friendly Undead +1/+2.',
  },
  { id: 'ZOMBIE', name: 'Зомби', type: 'Minion', techLevel: 2, races: ['UNDEAD'], isBaconPool: true },
  { id: 'BIG_ZOMBIE', name: 'Большой зомби', type: 'Minion', techLevel: 3, races: ['UNDEAD'], isBaconPool: true },
  { id: 'BEAST', name: 'Зверь', type: 'Minion', techLevel: 2, races: ['BEAST'], isBaconPool: true },
];
const cards = createCardIndex(STUB_CARDS);
const deps = { cards };
const rules = DEFAULT_TAVERN_RULES;

/** Энчант тёмного дара Fresh Perspective, как он лежит на теле в логе part74. */
const GIFT: Enchantment = {
  entityId: 9001,
  cardId: 'BG36_MidGameEffect_000t52e',
  timing: 9001,
  scriptDataNum1: null,
  scriptDataNum2: null,
};

const withGift = (m: Minion): Minion => ({ ...m, enchantments: [...m.enchantments, GIFT] });

const tavern = (patch: Partial<GameState>): GameState => ({
  ...EMPTY_STATE,
  phase: 'tavern',
  turn: 13,
  techLevel: 4,
  gold: 10,
  goldTotal: 10,
  ...patch,
});

describe('D292: ничья кандидатов в продажу решается против тела с тёмным даром', () => {
  const skull = (id: number, pos: number): Minion =>
    minion(id, { cardId: 'SKULL', zonePos: pos, attack: 7, health: 1, maxHealth: 1, reborn: true, techLevel: 2 });
  const others = [2, 3, 4, 5, 6].map((id) =>
    minion(id, { cardId: 'BIG_ZOMBIE', zonePos: id, attack: 30, health: 30, maxHealth: 30 }),
  );

  it('две одинаковые карты: продаётся та, что без дара, где бы она ни стояла', () => {
    const board = [withGift(skull(1, 1)), ...others, skull(7, 7)];
    const victim = weakestOwn(tavern({ board }), deps, rules);
    expect(victim?.minion.entityId).toBe(7);
  });

  it('без дара у обеих — ничья по-прежнему решается местом (левый)', () => {
    const board = [skull(1, 1), ...others, skull(7, 7)];
    expect(weakestOwn(tavern({ board }), deps, rules)?.minion.entityId).toBe(1);
  });

  it('тело с даром, которое СЛАБЕЕ по шкале, по-прежнему уходит первым: ценность не трогается', () => {
    const weaker = { ...withGift(skull(1, 1)), attack: 3 };
    const board = [weaker, ...others, skull(7, 7)];
    expect(weakestOwn(tavern({ board }), deps, rules)?.minion.entityId).toBe(1);
  });
});

describe('D293: клич-жертва называет, кого отдать', () => {
  const maw = minion(50, { cardId: 'MAW', attack: 4, health: 5, maxHealth: 5, techLevel: 4 });
  const giftedSkull = withGift(
    minion(11, { cardId: 'SKULL', zonePos: 1, attack: 3, health: 1, maxHealth: 1, reborn: true, techLevel: 2 }),
  );
  const zombie = minion(12, { cardId: 'ZOMBIE', zonePos: 2, attack: 2, health: 4, maxHealth: 4, techLevel: 2 });
  const bigZombie = minion(13, { cardId: 'BIG_ZOMBIE', zonePos: 3, attack: 17, health: 7, maxHealth: 7 });
  const beast = minion(14, { cardId: 'BEAST', zonePos: 4, attack: 1, health: 1, maxHealth: 1 });

  it('розыгрыш из руки: наименьший свой племени, тело с даром не отдаём', () => {
    const state = tavern({ board: [giftedSkull, zombie, bigZombie, beast], hand: [maw] });
    const play = playRules(state, deps, rules).find((r) => r.minion?.entityId === maw.entityId);
    expect(play?.targetMinion?.entityId).toBe(zombie.entityId);
    expect(play?.destroysTarget).toEqual({ rebornCopy: null });
    expect(play?.reason).toContain('Череп с тёмным даром не отдаём');
  });

  it('другого своего племени нет — отдаётся и тело с даром', () => {
    const state = tavern({ board: [giftedSkull, beast], hand: [maw] });
    const play = playRules(state, deps, rules).find((r) => r.minion?.entityId === maw.entityId);
    expect(play?.targetMinion?.entityId).toBe(giftedSkull.entityId);
    // Перерождение вернёт копию без энчантов — её план и поставит на место.
    expect(play?.destroysTarget?.rebornCopy?.enchantments).toEqual([]);
  });

  it('чужое племя жертвой не бывает: своих нежити нет — цели нет', () => {
    const state = tavern({ board: [beast], hand: [maw] });
    const play = playRules(state, deps, rules).find((r) => r.minion?.entityId === maw.entityId);
    expect(play?.targetMinion ?? null).toBeNull();
    expect(play?.destroysTarget).toBeUndefined();
  });

  it('покупка, встающая на борд, называет ту же жертву', () => {
    const shopMaw = { ...maw, entityId: 60 };
    const state = tavern({ board: [giftedSkull, zombie, bigZombie], shop: [shopMaw] });
    const buy = buyRules(state, deps, rules).find((r) => r.minion?.entityId === shopMaw.entityId);
    expect(buy?.targetMinion?.entityId).toBe(zombie.entityId);
  });

  it('план убирает жертву с борда', () => {
    const state = tavern({ board: [giftedSkull, zombie, bigZombie], hand: [maw] });
    const play = playRules(state, deps, rules).find((r) => r.minion?.entityId === maw.entityId);
    const after = applyRecommendation(state, play!, rules)?.state;
    expect(after?.board.map((m) => m.entityId)).toEqual([
      giftedSkull.entityId,
      bigZombie.entityId,
      maw.entityId,
    ]);
  });
});
