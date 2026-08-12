import { describe, expect, it } from 'vitest';

import {
  adviseTavern,
  buyRules,
  copiesOwned,
  freezeRule,
  levelUpRule,
  minionValue,
  rerollRule,
  sellRule,
  tribeMates,
} from '../../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES, targetTier } from '../../../src/advisors/tavern/rules.js';
import { createCardIndex } from '../../../src/data/cards.js';
import { EMPTY_STATE, type GameState, type Hero, type Minion } from '../../../src/state/types.js';
import { minion } from '../../minions.js';

/**
 * Юнит-тесты на каждое правило — прямое требование DoD фазы 4.
 *
 * Справочник карт здесь подставной и крошечный: правила не должны зависеть
 * от того, что именно лежит в снапшоте на 35 тысяч карт, а тест не должен
 * его читать. Настоящий снапшот проверяется отдельно, в сквозном тесте.
 */
const cards = createCardIndex([
  { id: 'MURLOC_1', name: 'Мурлок', techLevel: 1, races: ['MURLOC'], isBaconPool: true },
  { id: 'MURLOC_2', name: 'Другой мурлок', techLevel: 2, races: ['MURLOC'], isBaconPool: true },
  { id: 'DRAGON_1', name: 'Дракон', techLevel: 3, races: ['DRAGON'], isBaconPool: true },
  { id: 'AMALGAM', name: 'Амальгама', techLevel: 4, races: ['ALL'], isBaconPool: true },
  { id: 'NEUTRAL', name: 'Нейтральный', techLevel: 2, races: [], isBaconPool: true },
  { id: 'NEUTRAL_2', name: 'Другой нейтральный', techLevel: 2, races: [], isBaconPool: true },
]);
const deps = { cards };

const hero = (health: number, damage = 0, armor = 0): Hero => ({
  entityId: 1,
  cardId: 'TB_BaconShop_HERO_60',
  health,
  armor,
  damage,
  heroPowerCardId: null,
  heroPowerEntityId: null,
});

function state(patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn: 5,
    techLevel: 2,
    gold: 5,
    goldTotal: 5,
    hero: hero(40),
    ...patch,
  };
}

const shopMinion = (id: number, cardId: string, patch: Partial<Minion> = {}): Minion =>
  minion(id, { cardId, techLevel: cards.info(cardId)?.techLevel ?? 1, ...patch });

describe('таблица таймингов подъёма', () => {
  it('отдаёт тир, полагающийся к ходу', () => {
    expect(targetTier(1, DEFAULT_TAVERN_RULES)).toBe(1);
    expect(targetTier(2, DEFAULT_TAVERN_RULES)).toBe(1);
    expect(targetTier(3, DEFAULT_TAVERN_RULES)).toBe(2);
    expect(targetTier(6, DEFAULT_TAVERN_RULES)).toBe(3);
    expect(targetTier(11, DEFAULT_TAVERN_RULES)).toBe(6);
    // За концом таблицы значение держится, а не обнуляется.
    expect(targetTier(30, DEFAULT_TAVERN_RULES)).toBe(6);
  });

  it('читается из данных, а не из кода', () => {
    const custom = {
      ...DEFAULT_TAVERN_RULES,
      levelling: [
        { fromTurn: 1, tier: 1 },
        { fromTurn: 2, tier: 5 },
      ],
    };
    expect(targetTier(2, custom)).toBe(5);
  });
});

describe('племенная синергия', () => {
  it('считает своих того же племени', () => {
    const board = [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2'), shopMinion(3, 'DRAGON_1')];
    expect(tribeMates(shopMinion(9, 'MURLOC_1'), board, cards)).toBe(2);
    expect(tribeMates(shopMinion(9, 'DRAGON_1'), board, cards)).toBe(1);
  });

  it('амальгама своя для всех, и все свои для неё', () => {
    const board = [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'DRAGON_1')];
    expect(tribeMates(shopMinion(9, 'AMALGAM'), board, cards)).toBe(2);
    expect(tribeMates(shopMinion(9, 'MURLOC_1'), [shopMinion(1, 'AMALGAM')], cards)).toBe(1);
  });

  it('нейтральный миньон синергии не даёт и не получает', () => {
    expect(tribeMates(shopMinion(9, 'NEUTRAL'), [shopMinion(1, 'MURLOC_1')], cards)).toBe(0);
    expect(tribeMates(shopMinion(9, 'MURLOC_1'), [shopMinion(1, 'NEUTRAL')], cards)).toBe(0);
  });
});

describe('счёт копий под тройку', () => {
  it('считает борд и руку вместе', () => {
    const s = state({
      board: [shopMinion(1, 'MURLOC_1')],
      hand: [shopMinion(2, 'MURLOC_1')],
    });
    expect(copiesOwned(shopMinion(9, 'MURLOC_1'), s)).toBe(2);
  });

  it('золотые копии не идут в счёт: тройка собирается из трёх обычных', () => {
    const s = state({ board: [shopMinion(1, 'MURLOC_1', { golden: true })] });
    expect(copiesOwned(shopMinion(9, 'MURLOC_1'), s)).toBe(0);
    // И сам золотой кандидат тройку не собирает.
    expect(copiesOwned(shopMinion(9, 'MURLOC_1', { golden: true }), state({ board: [shopMinion(1, 'MURLOC_1')] }))).toBe(0);
  });
});

describe('ценность миньона', () => {
  it('складывается из тира, статов, племени, ключевых слов и копий', () => {
    const s = state({ board: [shopMinion(1, 'MURLOC_1')] });
    const v = minionValue(shopMinion(9, 'MURLOC_2', { attack: 4, health: 6, taunt: true }), s, deps);

    expect(v.techLevel).toBe(2 * DEFAULT_TAVERN_RULES.value.perTechLevel);
    expect(v.stats).toBe(10 * DEFAULT_TAVERN_RULES.value.perStatPoint);
    expect(v.tribe).toBe(1 * DEFAULT_TAVERN_RULES.value.perTribeMate);
    expect(v.keywords).toBe(DEFAULT_TAVERN_RULES.value.taunt);
    expect(v.total).toBeCloseTo(v.techLevel + v.stats + v.tribe + v.keywords, 6);
  });

  it('третья копия ценится сильнее всего остального', () => {
    const plain = state();
    const twoCopies = state({ board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_1')] });
    const candidate = shopMinion(9, 'MURLOC_1');

    const gain = minionValue(candidate, twoCopies, deps).copies;
    expect(gain).toBe(DEFAULT_TAVERN_RULES.copiesBonus[2]);
    expect(gain).toBeGreaterThan(minionValue(candidate, plain, deps).total);
  });

  it('бонус за копии не растёт дальше третьей', () => {
    const three = state({ board: [1, 2, 3].map((i) => shopMinion(i, 'MURLOC_1')) });
    expect(minionValue(shopMinion(9, 'MURLOC_1'), three, deps).copies).toBe(
      DEFAULT_TAVERN_RULES.copiesBonus[2],
    );
  });
});

describe('правило подъёма таверны', () => {
  const upgradable = (patch: Partial<GameState> = {}): GameState =>
    state({ tavernUpgradeCost: 5, tavernUpgradeTarget: 3, maxTechLevel: 6, ...patch });

  it('молчит, когда кнопки апгрейда нет', () => {
    expect(levelUpRule(state({ tavernUpgradeCost: null }))).toBeNull();
  });

  it('молчит на максимальном тире', () => {
    expect(levelUpRule(upgradable({ techLevel: 6, maxTechLevel: 6 }))).toBeNull();
  });

  it('молчит, когда золота не хватает', () => {
    expect(levelUpRule(upgradable({ gold: 4 }))).toBeNull();
  });

  it('советует тем настойчивее, чем сильнее отставание от таблицы', () => {
    // Ход 9 требует тира 5; при тире 2 отставание в три тира.
    const behind = levelUpRule(upgradable({ turn: 9, techLevel: 2, gold: 10 }));
    const onTrack = levelUpRule(upgradable({ turn: 5, techLevel: 3, gold: 10 }));

    expect(behind?.score).toBe(3 * DEFAULT_TAVERN_RULES.levellingUrgencyPerTier);
    expect(onTrack?.score).toBe(0);
    expect(behind?.reason).toContain('ожидаемых 5');
  });

  it('на низком здоровье подъём не советуется, и сказано почему', () => {
    const hurt = levelUpRule(upgradable({ gold: 10, hero: hero(40, 30) }));
    expect(hurt?.score).toBe(0);
    expect(hurt?.reason).toContain('здоровья 10');
  });

  it('броня считается здоровьем', () => {
    const armored = levelUpRule(upgradable({ turn: 9, gold: 10, hero: hero(40, 35, 12) }));
    expect(armored?.score).toBeGreaterThan(0);
  });
});

describe('правило покупки', () => {
  it('не предлагает то, на что не хватает золота', () => {
    expect(buyRules(state({ gold: 2, shop: [shopMinion(9, 'MURLOC_1')] }), deps)).toHaveLength(0);
  });

  it('оценивает каждого миньона витрины', () => {
    const s = state({ gold: 6, shop: [shopMinion(9, 'MURLOC_1'), shopMinion(10, 'DRAGON_1')] });
    const buys = buyRules(s, deps);
    expect(buys).toHaveLength(2);
    expect(buys.every((b) => b.action === 'buy')).toBe(true);
    expect(buys.every((b) => b.cost === DEFAULT_TAVERN_RULES.minionCost)).toBe(true);
  });

  it('на полном борде помечает, что нужно освободить место', () => {
    const s = state({
      gold: 6,
      board: Array.from({ length: 7 }, (_, i) => shopMinion(i + 1, 'NEUTRAL')),
      shop: [shopMinion(9, 'MURLOC_1')],
    });
    const buy = buyRules(s, deps)[0];
    expect(buy?.requiresSlot).toBe(true);
    expect(buy?.reason).toContain('борд полон');
  });
});

describe('правило продажи', () => {
  const full = (patch: Partial<GameState> = {}): GameState =>
    state({
      gold: 6,
      board: Array.from({ length: 7 }, (_, i) => shopMinion(i + 1, 'NEUTRAL', { attack: 1, health: 1 })),
      ...patch,
    });

  it('молчит, пока на борде есть место', () => {
    expect(sellRule(state({ gold: 6, board: [], shop: [shopMinion(9, 'AMALGAM')] }), deps)).toBeNull();
  });

  it('молчит, когда витрина не лучше своих', () => {
    // Карта витрины намеренно другая: копия своей же собрала бы тройку,
    // и совет продавать был бы верным по другой причине.
    const s = full({ shop: [shopMinion(9, 'NEUTRAL_2', { attack: 1, health: 1 })] });
    expect(sellRule(s, deps)).toBeNull();
  });

  it('советует расстаться со слабейшим ради явно лучшего', () => {
    const s = full({ shop: [shopMinion(9, 'AMALGAM', { attack: 8, health: 8 })] });
    const sell = sellRule(s, deps);
    expect(sell?.action).toBe('sell');
    expect(sell?.minion?.cardId).toBe('NEUTRAL');
    expect(sell?.reason).toContain('борд полон');
  });

  it('порог разницы берётся из данных', () => {
    const s = full({ shop: [shopMinion(9, 'AMALGAM', { attack: 8, health: 8 })] });
    const huge = { ...DEFAULT_TAVERN_RULES, sellMargin: 1000 };
    expect(sellRule(s, deps, huge)).toBeNull();
  });
});

describe('правило обновления витрины', () => {
  it('советует, когда покупать нечего', () => {
    const s = state({ gold: 4, shop: [shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 })] });
    const reroll = rerollRule(s, deps);
    expect(reroll?.action).toBe('reroll');
    expect(reroll?.cost).toBe(DEFAULT_TAVERN_RULES.rerollCost);
  });

  it('молчит, когда в витрине есть что-то стоящее', () => {
    const s = state({ gold: 4, shop: [shopMinion(9, 'AMALGAM', { attack: 8, health: 8 })] });
    expect(rerollRule(s, deps)).toBeNull();
  });

  it('не ворует золото у подъёма таверны', () => {
    // Золота ровно на подъём; после обновления не хватит.
    const s = state({
      gold: 5,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
      shop: [shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 })],
    });
    expect(rerollRule(s, deps)).toBeNull();

    // А с запасом — советует.
    expect(rerollRule({ ...s, gold: 7 }, deps)).not.toBeNull();
  });

  it('молчит без золота', () => {
    expect(rerollRule(state({ gold: 0, shop: [shopMinion(9, 'MURLOC_1')] }), deps)).toBeNull();
  });
});

describe('правило заморозки', () => {
  const rich = shopMinion(9, 'AMALGAM', { attack: 10, health: 10, divineShield: true });
  const alsoRich = shopMinion(10, 'DRAGON_1', { attack: 9, health: 9, taunt: true });

  it('советует держать витрину ради второго ценного, на которого не хватило', () => {
    // Золота ровно на одну покупку, а ценных двое: купленный уйдёт с борда,
    // второй пропадёт вместе с витриной, если её не заморозить.
    const s = state({ gold: 3, shop: [rich, alsoRich] });
    const freeze = freezeRule(s, deps);
    expect(freeze?.action).toBe('freeze');
    expect(freeze?.minion?.cardId).toBe('DRAGON_1');
  });

  it('молчит, когда за одним ценным стоит только хлам', () => {
    const s = state({ gold: 3, shop: [rich, shopMinion(11, 'NEUTRAL', { attack: 1, health: 1 })] });
    expect(freezeRule(s, deps)).toBeNull();
  });

  it('молчит, когда ценного хватает на всё золото', () => {
    const s = state({ gold: 9, shop: [rich, alsoRich] });
    expect(freezeRule(s, deps)).toBeNull();
  });

  it('молчит, когда витрина уже заморожена', () => {
    const s = state({
      gold: 3,
      shop: [{ ...rich, frozen: true }, { ...alsoRich, frozen: true }],
    });
    expect(freezeRule(s, deps)).toBeNull();
  });

  it('молчит, когда недоступное того не стоит', () => {
    const s = state({ gold: 3, shop: [shopMinion(10, 'NEUTRAL'), shopMinion(11, 'NEUTRAL')] });
    expect(freezeRule(s, deps)).toBeNull();
  });
});

describe('совет целиком', () => {
  it('вне таверны советов нет', () => {
    expect(adviseTavern(state({ phase: 'combat' }), deps)).toBeNull();
    expect(adviseTavern(state({ phase: 'gameOver' }), deps)).toBeNull();
  });

  it('рекомендации отсортированы по убыванию очков', () => {
    const s = state({
      gold: 10,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
      shop: [shopMinion(9, 'MURLOC_1'), shopMinion(10, 'AMALGAM', { attack: 8, health: 8 })],
    });
    const advice = adviseTavern(s, deps);
    const scores = advice?.recommendations.map((r) => r.score) ?? [];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('«ничего не делать» есть всегда — это точка отсчёта', () => {
    const advice = adviseTavern(state({ gold: 0, shop: [] }), deps);
    expect(advice?.recommendations.map((r) => r.action)).toContain('pass');
  });

  it('третья копия перевешивает подъём таверны', () => {
    const s = state({
      turn: 9,
      techLevel: 2,
      gold: 10,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_1')],
      shop: [shopMinion(9, 'MURLOC_1')],
    });
    const first = adviseTavern(s, deps)?.recommendations[0];
    expect(first?.action).toBe('buy');
    expect(first?.reason).toContain('собирает тройку');
  });
});
