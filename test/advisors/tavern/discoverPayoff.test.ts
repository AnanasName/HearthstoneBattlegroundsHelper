import { describe, expect, it } from 'vitest';

import {
  activationRules,
  discoverPayoffOf,
  minionValue,
  spellRules,
  spinRule,
} from '../../../src/advisors/tavern/advisor.js';
import { createCardIndex } from '../../../src/data/cards.js';
import { EMPTY_STATE, type GameState, type Hero } from '../../../src/state/types.js';
import { minion } from '../../minions.js';

/**
 * Плательщик за Discover (D232): «After you Discover a card, give your other
 * Pirates +{0}/+{1}» (Hooktusk, Master Marauder `BG36_344`, part55).
 * Тексты — дословно снапшот.
 */
const cards = createCardIndex([
  {
    id: 'HOOK',
    name: 'Hooktusk, Master Marauder',
    type: 'Minion',
    techLevel: 6,
    races: ['PIRATE'],
    text: '[x]After you <b>Discover</b> a card, give your other Pirates +{0}/+{1}. <i>(Improved by Golden minions you played this game!)</i>',
  },
  { id: 'PIRATE', name: 'Пират', type: 'Minion', techLevel: 2, races: ['PIRATE'] },
  { id: 'AMALGAM', name: 'Амальгама', type: 'Minion', techLevel: 2, races: ['ALL'] },
  { id: 'BEAST', name: 'Зверь', type: 'Minion', techLevel: 2, races: ['BEAST'] },
  {
    id: 'RODEO',
    name: 'Rodeo Performer',
    type: 'Minion',
    techLevel: 3,
    attack: 3,
    health: 4,
    races: [],
    isBaconPool: true,
    mechanics: ['BATTLECRY'],
    text: '<b>Battlecry:</b> <b>Discover</b> a Tavern spell.',
  },
  {
    id: 'BRANN',
    name: 'Brann Bronzebeard',
    type: 'Minion',
    techLevel: 5,
    races: [],
    text: 'Your <b>Battlecries</b> trigger twice.',
  },
  {
    id: 'SCOUT',
    name: 'Patient Scout',
    type: 'Minion',
    techLevel: 2,
    attack: 1,
    health: 1,
    races: [],
    isBaconPool: true,
    text: '[x]When you sell this, <b>Discover</b> a Tier 1 minion. <i>(Improves each turn!)</i>',
  },
  { id: 'T1', name: 'Первый', type: 'Minion', techLevel: 1, attack: 2, health: 2, races: [], isBaconPool: true },
  {
    id: 'REWARD',
    name: 'Triple Reward',
    type: 'Spell',
    text: '<b>Discover</b> a minion from <b>Tier {0}</b>.',
  },
  {
    id: 'CASTAWAY',
    name: 'Clever Castaway',
    type: 'Minion',
    techLevel: 2,
    races: ['PIRATE'],
    text: '<b>Activate ({0}): Discover</b> a Tavern spell.',
  },
  {
    id: 'MIRROR',
    name: 'Mirror Monster',
    type: 'Minion',
    techLevel: 2,
    races: [],
    mechanics: ['BATTLECRY'],
    text: 'When you buy or <b>Discover</b> this, get an extra copy and <b>Pass</b> it.',
  },
]);
const deps = { cards };

const hero = (): Hero => ({
  entityId: 1,
  cardId: 'HERO',
  health: 30,
  armor: 0,
  damage: 0,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerExhausted: null,
  heroPowerDisabled: false,
  heroPowerScriptData: [],
});

const hook = (id: number, each = 4) =>
  minion(id, { cardId: 'HOOK', attack: 30, health: 30, techLevel: 6, scriptData: [each, each, null, null, null, null] });
const pirate = (id: number) => minion(id, { cardId: 'PIRATE', attack: 10, health: 10, techLevel: 2 });

function state(patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn: 19,
    techLevel: 5,
    gold: 10,
    goldTotal: 10,
    hero: hero(),
    ...patch,
  };
}

describe('плательщик за Discover (D232, part55)', () => {
  it('прибавка — живые числа носителя на каждого ДРУГОГО своего пирата', () => {
    const board = [
      hook(1),
      pirate(2),
      pirate(3),
      minion(4, { cardId: 'AMALGAM', techLevel: 2 }),
      minion(5, { cardId: 'BEAST', techLevel: 2 }),
    ];
    // (4 + 4) × три получателя (два пирата и амальгама) × 0.5.
    expect(discoverPayoffOf(board, cards)?.points).toBe(12);
    expect(discoverPayoffOf(board, cards)?.payers).toEqual(['Hooktusk, Master Marauder']);
    // Без получателей и без носителя — ничего.
    expect(discoverPayoffOf([hook(1)], cards)).toBeNull();
    expect(discoverPayoffOf([pirate(2), pirate(3)], cards)).toBeNull();
    // Нулевые плейсхолдеры — ничего.
    expect(discoverPayoffOf([hook(1, 0), pirate(2)], cards)).toBeNull();
  });

  it('кличевой с Discover получает прибавку за каждое срабатывание клича', () => {
    const rodeo = minion(20, { cardId: 'RODEO', attack: 3, health: 4, techLevel: 3 });
    const plain = minionValue(rodeo, state({ board: [pirate(2)] }), deps).discoverPayoff;
    expect(plain).toBe(0);
    const fed = minionValue(rodeo, state({ board: [hook(1), pirate(2)] }), deps).discoverPayoff;
    expect(fed).toBe(4);
    const doubled = minionValue(
      rodeo,
      state({ board: [hook(1), pirate(2), minion(3, { cardId: 'BRANN', techLevel: 5 })] }),
      deps,
    ).discoverPayoff;
    expect(doubled).toBe(8);
    // Слово в триггере «When you buy or Discover this» — не действие карты.
    const mirror = minion(21, { cardId: 'MIRROR', techLevel: 2 });
    expect(minionValue(mirror, state({ board: [hook(1), pirate(2)] }), deps).discoverPayoff).toBe(0);
  });

  it('прокрутка продажного генератора с Discover окупается плательщиком', () => {
    const scout = minion(30, { cardId: 'SCOUT', attack: 1, health: 1, techLevel: 2 });
    const shop = [scout];
    const without = spinRule(state({ board: [pirate(2)], shop }), deps);
    const withHook = spinRule(state({ board: [hook(1), pirate(2), pirate(3)], shop }), deps);
    expect(withHook?.action).toBe('spin');
    expect(withHook?.reason).toContain('Discover кормит своих');
    // (4 + 4) × 2 × 0.5 = 8 сверх того, что прокрутка стоила без плательщика.
    expect((withHook?.standaloneScore ?? 0) - (without?.standaloneScore ?? 0)).toBeCloseTo(8, 9);
  });

  it('на полном борде плательщик открывает прокрутку через продажу слабейшего, но не себя', () => {
    const board = [hook(1), ...[2, 3, 4, 5, 6, 7].map((id) => pirate(id))];
    board[6] = minion(7, { cardId: 'BEAST', attack: 1, health: 1, techLevel: 1 });
    const scout = minion(30, { cardId: 'SCOUT', attack: 1, health: 1, techLevel: 2 });
    const spin = spinRule(state({ board, shop: [scout] }), deps);
    expect(spin?.action).toBe('spin');
    expect(spin?.sellFirst?.cardId).toBe('BEAST');
  });

  it('заклинание руки с Discover разыгрывается ради плательщика, без него — молчит', () => {
    const reward = {
      entityId: 50,
      cardId: 'REWARD',
      cost: 0,
      zonePos: 1,
      scriptData: [4],
      unplayable: false,
      costsHealth: false,
    };
    expect(spellRules(state({ board: [pirate(2)], handSpells: [reward] }), deps)).toEqual([]);
    const recs = spellRules(state({ board: [hook(1), pirate(2)], handSpells: [reward] }), deps);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.score).toBe(4);
    expect(recs[0]?.reason).toContain('Discover кормит своих');
  });

  it('активация с Discover получает прибавку плательщика', () => {
    const castaway = minion(40, {
      cardId: 'CASTAWAY',
      techLevel: 2,
      tags: { HAS_ACTIVATE_POWER: 1, INTERACTABLE_OBJECT_COST: 1 },
    });
    const without = activationRules(state({ board: [castaway, pirate(2)] }), deps)[0]?.score ?? 0;
    const withHook = activationRules(state({ board: [castaway, hook(1), pirate(2)] }), deps)[0]?.score ?? 0;
    // Получатели — Castaway и пират: (4 + 4) × 2 × 0.5.
    expect(withHook - without).toBeCloseTo(8, 9);
  });
});
