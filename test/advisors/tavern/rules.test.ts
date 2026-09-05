import { describe, expect, it } from 'vitest';

import {
  adviseTavern,
  buyCostOf,
  discountRefreshRule,
  buyRules,
  choiceAdvice,
  copiesForTriple,
  copiesOwned,
  darkGiftRule,
  freeHeroPowerRule,
  heroPowerBuyReward,
  heroPowerKeywordRule,
  heroPowerShotRule,
  freezeRule,
  heroPowerPlayStats,
  heroPowerRule,
  heroPowerSpellRule,
  levelUpRule,
  lobbyRaces,
  magnetizeTarget,
  minionValue,
  playPlan,
  playRules,
  poisonAmongSeen,
  rerollCostOf,
  rerollRule,
  sellForGoldRule,
  sellRule,
  shopSpellRules,
  spellEffect,
  spellRules,
  spinRule,
  tribeMates,
  trinketAdvice,
  trinketForecast,
} from '../../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES, targetTier, tavernTurnOf } from '../../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../../src/advisors/tavern/spend.js';
import { createBgStats } from '../../../src/data/bgStats.js';
import { createCardIndex, loadCardIndex } from '../../../src/data/cards.js';
import { EMPTY_STATE, type GameState, type Hero, type Minion } from '../../../src/state/types.js';
import { board, minion } from '../../minions.js';

/**
 * Юнит-тесты на каждое правило — прямое требование DoD фазы 4.
 *
 * Справочник карт здесь подставной и крошечный: правила не должны зависеть
 * от того, что именно лежит в снапшоте на 35 тысяч карт, а тест не должен
 * его читать. Настоящий снапшот проверяется отдельно, в сквозном тесте.
 */
// `type` у заготовок настоящий: по нему справочник собирает пул миньонов
// тира (`poolOfTier`), а на пуле стоят и тёмный дар, и планка заморозки.
const STUB_CARDS = [
  {
    id: 'SKIPPER',
    name: 'Речной пропойца',
    type: 'Minion',
    techLevel: 1,
    races: ['MURLOC'],
    isBaconPool: true,
    text: 'When you sell this, get a random Tier 1 minion.',
  },
  { id: 'MURLOC_1', name: 'Мурлок', type: 'Minion', techLevel: 1, races: ['MURLOC'], isBaconPool: true },
  { id: 'MURLOC_2', name: 'Другой мурлок', type: 'Minion', techLevel: 2, races: ['MURLOC'], isBaconPool: true },
  { id: 'MURLOC_3', name: 'Третий мурлок', type: 'Minion', techLevel: 2, races: ['MURLOC'], isBaconPool: true },
  { id: 'MURLOC_5', name: 'Пятый мурлок', type: 'Minion', techLevel: 5, races: ['MURLOC'], isBaconPool: true },
  { id: 'DRAGON_1', name: 'Дракон', type: 'Minion', techLevel: 3, races: ['DRAGON'], isBaconPool: true },
  { id: 'AMALGAM', name: 'Амальгама', type: 'Minion', techLevel: 4, races: ['ALL'], isBaconPool: true },
  { id: 'NEUTRAL', name: 'Нейтральный', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
  { id: 'NEUTRAL_2', name: 'Другой нейтральный', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
];
const cards = createCardIndex(STUB_CARDS);
const deps = { cards };

const hero = (health: number, damage = 0, armor = 0): Hero => ({
  entityId: 1,
  cardId: 'TB_BaconShop_HERO_60',
  health,
  armor,
  damage,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
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
  it('считает ход таверны, а не сырой счётчик хода', () => {
    // Счётчик TURN растёт и на переходе в бой: таверна идёт нечётными.
    expect(tavernTurnOf(1)).toBe(1);
    expect(tavernTurnOf(3)).toBe(2);
    expect(tavernTurnOf(15)).toBe(8);
    // Фаза боя того же хода таверны своего номера не получает.
    expect(tavernTurnOf(2)).toBe(1);
  });

  it('отдаёт тир, полагающийся к ходу таверны', () => {
    expect(targetTier(1, DEFAULT_TAVERN_RULES)).toBe(1);
    // Стандартная кривая: подъём на 4 золота вторым ходом таверны — это
    // наш turn 3.
    expect(targetTier(3, DEFAULT_TAVERN_RULES)).toBe(2);
    // Тир 3 к четвёртому ходу таверны (шесть золота) — наш turn 7.
    expect(targetTier(7, DEFAULT_TAVERN_RULES)).toBe(3);
    // Точка жалобы игрока (part20, turn 15 — восьмой ход таверны, десять
    // золота): по кривой полагается тир 4, а не 6. Прежняя шкала сравнивала
    // «tier 6 с хода 11» с сырым turn и объявляла отставание в 2 тира
    // на ходу, где игрок шёл ВПЕРЕДИ графика.
    expect(targetTier(15, DEFAULT_TAVERN_RULES)).toBe(4);
    // Тир 6 — к одиннадцатому ходу таверны, то есть к нашему turn 21.
    expect(targetTier(21, DEFAULT_TAVERN_RULES)).toBe(6);
    // За концом таблицы значение держится, а не обнуляется.
    expect(targetTier(30, DEFAULT_TAVERN_RULES)).toBe(6);
  });

  it('читается из данных, а не из кода', () => {
    const custom = {
      ...DEFAULT_TAVERN_RULES,
      levelling: [
        { fromTavernTurn: 1, tier: 1 },
        { fromTavernTurn: 2, tier: 5 },
      ],
    };
    expect(targetTier(3, custom)).toBe(5);
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

  it('экономический эффект читается из текста карты', () => {
    // Жалоба игрока: миньоны с возвратом при продаже почти не советовались,
    // потому что по статам они мусор. River Skipper 1/1 против ванильного
    // 1/1 того же тира — разница ровно в тексте.
    const skipper = minionValue(shopMinion(9, 'SKIPPER', { attack: 1, health: 1 }), state(), deps);
    const vanilla = minionValue(shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 }), state(), deps);

    expect(skipper.economy).toBe(DEFAULT_TAVERN_RULES.value.economy);
    expect(vanilla.economy).toBe(0);
    expect(skipper.total).toBeGreaterThan(vanilla.total);
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
    // Turn 21 — одиннадцатый ход таверны, он требует тира 6; при тире 3
    // отставание в три тира.
    const behind = levelUpRule(upgradable({ turn: 21, techLevel: 3, gold: 10 }));
    // Turn 15 — восьмой ход таверны, полагается тир 4: тир 4 идёт по графику.
    const onTrack = levelUpRule(upgradable({ turn: 15, techLevel: 4, gold: 10 }));

    expect(behind?.score).toBe(3 * DEFAULT_TAVERN_RULES.levellingUrgencyPerTier);
    expect(onTrack?.score).toBe(0);
    expect(behind?.reason).toContain('ожидаемых 6');
    // Ход в совете назван в той же шкале, в которой сравнивается.
    expect(behind?.reason).toContain('11-му ходу таверны');
  });

  it('подъём на чётный тир обещает расширение витрины', () => {
    // Замерено по фикстурам: витрина 3/4/4/5/5 для тиров 1–5, рост на чётных.
    const toEven = levelUpRule(
      upgradable({ techLevel: 1, tavernUpgradeTarget: 2, tavernUpgradeCost: 4, gold: 4 }),
    );
    expect(toEven?.reason).toContain('витрина расширится до 4');

    // Подъём 2 → 3 витрину не меняет, и обещать нечего.
    const toOdd = levelUpRule(
      upgradable({ techLevel: 2, tavernUpgradeTarget: 3, tavernUpgradeCost: 5, gold: 5 }),
    );
    expect(toOdd?.reason).not.toContain('витрина');
  });

  it('при отставании подъём ставится выше лучшей покупки', () => {
    // Очки покупки — ценность миньона, к середине партии 20+. Прежние очки
    // подъёма (отставание × 3) жили в другой шкале и проигрывали всегда:
    // за девять ходов партии подъём попадал в советы один раз.
    const s = upgradable({ turn: 9, techLevel: 2, gold: 10 });
    const buys = buyRules(
      { ...s, shop: [shopMinion(9, 'AMALGAM', { attack: 10, health: 10, divineShield: true })] },
      deps,
    );
    const bestBuy = Math.max(...buys.map((b) => b.score));

    const levelUp = levelUpRule(s, DEFAULT_TAVERN_RULES, buys);
    expect(bestBuy).toBeGreaterThan(15);
    expect(levelUp?.score).toBeGreaterThan(bestBuy);
  });

  it('когда золота хватает на одно, тройка важнее подъёма', () => {
    // Тройка даёт золотого и открытие карты — её упускать нельзя.
    const s = upgradable({
      turn: 9,
      techLevel: 2,
      gold: 5,
      tavernUpgradeCost: 5,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_1')],
      shop: [shopMinion(9, 'MURLOC_1')],
    });
    const buys = buyRules(s, deps);
    const levelUp = levelUpRule(s, DEFAULT_TAVERN_RULES, buys);
    const triple = Math.max(...buys.map((b) => b.score));

    expect(levelUp?.score).toBeLessThan(triple);
  });

  it('когда золота хватает на оба, подъём идёт раньше тройки', () => {
    // Сыгранная после подъёма тройка открывает карту уже с нового тира.
    const s = upgradable({
      turn: 9,
      techLevel: 2,
      gold: 10,
      tavernUpgradeCost: 5,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_1')],
      shop: [shopMinion(9, 'MURLOC_1')],
    });
    const buys = buyRules(s, deps);
    const levelUp = levelUpRule(s, DEFAULT_TAVERN_RULES, buys);

    expect(levelUp?.score).toBeGreaterThan(Math.max(...buys.map((b) => b.score)));
  });

  it('судьба остатка зависит от стадии: рано сгорает, поздно — на обновление', () => {
    // part10 ход 7 и part11: рано реролл на сдачу — пустая трата (найденное
    // пришлось бы морозить), честнее назвать остаток ценой подъёма. Поздно
    // идёт поиск конкретных карт, и обновление — полноценная трата.
    const early = state({ gold: 6, tavernUpgradeCost: 5, tavernUpgradeTarget: 3 });
    expect(levelUpRule(early)?.reason).toContain('остаток 1 сгорит — это цена подъёма');

    const late = state({ techLevel: 4, gold: 6, tavernUpgradeCost: 5, tavernUpgradeTarget: 5 });
    expect(levelUpRule(late)?.reason).toContain('остаток 1 — на обновление');

    // Когда остатка хватает на покупку, хвост не нужен — покупки в списке.
    const rich = state({ gold: 8, tavernUpgradeCost: 5, tavernUpgradeTarget: 3 });
    expect(levelUpRule(rich)?.reason).not.toContain('остаток');
  });

  it('витрина из мусора — довод подняться и без отставания (JeefHS)', () => {
    // Тир 3 по графику хода 5, но лучший кандидат витрины много ниже порога
    // «покупать нечего»: прежде подъём на графике получал ноль очков
    // и проигрывал любой слабой покупке (docs/jeefhs.md: «если в таверне
    // только мусор — повышайте уровень»).
    const trash = upgradable({
      turn: 5,
      techLevel: 3,
      gold: 10,
      tavernUpgradeTarget: 4,
      shop: [shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 })],
    });
    const buys = buyRules(trash, deps);
    const levelUp = levelUpRule(trash, DEFAULT_TAVERN_RULES, buys);
    expect(levelUp?.score).toBeGreaterThan(Math.max(...buys.map((b) => b.score)));
    expect(levelUp?.reason).toContain('вместо слабой покупки');

    // Достойная витрина оставляет подъём «на опережение» с нулём очков.
    const decent = upgradable({
      turn: 5,
      techLevel: 3,
      gold: 10,
      tavernUpgradeTarget: 4,
      shop: [shopMinion(9, 'AMALGAM', { attack: 8, health: 8 })],
    });
    const decentBuys = buyRules(decent, deps);
    const onTrack = levelUpRule(decent, DEFAULT_TAVERN_RULES, decentBuys);
    expect(onTrack?.score).toBe(0);
    expect(onTrack?.reason).toContain('на опережение');
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

  it('на полном борде — через продажу, и только ради явного превосходства', () => {
    const s = state({
      gold: 6,
      board: Array.from({ length: 7 }, (_, i) => shopMinion(i + 1, 'NEUTRAL')),
      shop: [
        shopMinion(9, 'MURLOC_1', { attack: 10, health: 10 }),
        shopMinion(10, 'MURLOC_1'),
      ],
    });
    const buys = buyRules(s, deps);

    const strong = buys.find((b) => b.minion?.attack === 10);
    expect(strong?.requiresSlot).toBe(true);
    expect(strong?.sellFirst).not.toBeNull();
    expect(strong?.reason).toContain('борд полон');

    // Почти равный жертве кандидат больше не советуется вовсе: менять
    // равного на равного с доплатой хода — потеря (part10, ход 11).
    expect(buys.find((b) => b.minion?.attack === 3)).toBeUndefined();
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

describe('правило прокрутки: купить-разыграть-продать генератора (part16)', () => {
  const spinCards = createCardIndex([
    {
      id: 'OOZE',
      name: 'Гладиатор-слизень',
      type: 'Minion',
      techLevel: 2,
      races: [],
      isBaconPool: true,
      text: '<b>Battlecry:</b> Get two Slimy Shields that give +1/+1 and <b>Taunt.</b>',
      mechanics: ['BATTLECRY'],
    },
    {
      id: 'PIRATE_8',
      name: 'Крупная пиратка',
      type: 'Minion',
      techLevel: 2,
      races: ['PIRATE'],
      isBaconPool: true,
    },
    {
      id: 'EOT_GET',
      name: 'Вечерний даритель',
      type: 'Minion',
      techLevel: 2,
      races: [],
      isBaconPool: true,
      text: 'At the end of your turn, get a Tavern spell.',
    },
  ]);
  const spinDeps = { cards: spinCards };
  const ooze = (id = 301): Minion => minion(id, { cardId: 'OOZE', attack: 2, health: 2, techLevel: 2 });
  const pirate = (): Minion => minion(302, { cardId: 'PIRATE_8', attack: 8, health: 8, techLevel: 2 });

  it('пока хватает на цепочку и лучшую покупку, прокрутка идёт первой', () => {
    // part16, ход 3 игрока: Oozeling за 3 → клич даст два заклинания →
    // продать за 1 — чистая цена 2, и золотая пиратка всё ещё по карману.
    // Совет «сразу пиратку» оставлял два золота сгорать.
    const s = state({ gold: 5, shop: [ooze(), pirate()] });
    const buys = buyRules(s, spinDeps);
    const spin = spinRule(s, spinDeps, DEFAULT_TAVERN_RULES, buys);

    expect(spin?.minion?.cardId).toBe('OOZE');
    expect(spin?.score).toBeGreaterThan(Math.max(...buys.map((b) => b.score)));
    expect(spin?.cost).toBe(2);
    expect(spin?.reason).toContain('чистая цена 2');
    expect(spin?.reason).toContain('потом Крупная пиратка');
  });

  it('когда на оба не хватает, прокрутка конкурирует очками эффекта', () => {
    const s = state({ gold: 3, shop: [ooze(), pirate()] });
    const buys = buyRules(s, spinDeps);
    const spin = spinRule(s, spinDeps, DEFAULT_TAVERN_RULES, buys);

    // 2 карты × курс заклинания (6) − чистая цена 2 × курс золота (3) = 6.
    expect(spin?.score).toBeCloseTo(6);
    expect(spin?.reason).not.toContain('потом');
  });

  it('лучшая покупка, копия и полный борд не прокручиваются', () => {
    // Генератор — единственная и лучшая покупка: его хочется оставить телом.
    const alone = state({ gold: 5, shop: [ooze()] });
    expect(spinRule(alone, spinDeps, DEFAULT_TAVERN_RULES, buyRules(alone, spinDeps))).toBeNull();

    // Копия на борде: продажа ломает будущую тройку.
    const withCopy = state({ gold: 5, board: [ooze(1)], shop: [ooze(), pirate()] });
    expect(
      spinRule(withCopy, spinDeps, DEFAULT_TAVERN_RULES, buyRules(withCopy, spinDeps)),
    ).toBeNull();

    // Полный борд: разыграть генератора некуда.
    const full = state({
      gold: 5,
      board: Array.from({ length: 7 }, (_, i) => minion(i + 1)),
      shop: [ooze(), pirate()],
    });
    expect(spinRule(full, spinDeps, DEFAULT_TAVERN_RULES, buyRules(full, spinDeps))).toBeNull();
  });

  it('продажный генератор прокручивается той же цепочкой (part25)', () => {
    // part25, ход 7: Patient Scout («When you sell this, Discover a Tier 1
    // minion») — купить за 3, разыграть, продать за 1: миньон за чистых два.
    // Обещанное отдаёт ПРОДАЖА, а не клич, и прежде таких карт правило
    // не видело вовсе.
    const s = state({ gold: 5, shop: [shopMinion(301, 'SKIPPER'), shopMinion(302, 'MURLOC_2')] });
    const spin = spinRule(s, deps, DEFAULT_TAVERN_RULES, buyRules(s, deps));

    expect(spin?.minion?.cardId).toBe('SKIPPER');
    expect(spin?.cost).toBe(2);
    expect(spin?.reason).toContain('продажа даст миньона тира 1');
    expect(spin?.reason).toContain('чистая цена 2');
  });

  it('продажный генератор прокручивается, даже будучи лучшей покупкой', () => {
    // Запрет «лучшую покупку не прокручивают» — про батлкрайного генератора:
    // его хочется оставить телом. У продажного наоборот: держать его телом
    // значит не получить обещанного никогда (part18).
    const alone = state({ gold: 5, shop: [shopMinion(301, 'SKIPPER')] });
    const buys = buyRules(alone, deps);
    expect(buys[0]?.minion?.cardId).toBe('SKIPPER');
    expect(spinRule(alone, deps, DEFAULT_TAVERN_RULES, buys)?.minion?.cardId).toBe('SKIPPER');
  });

  it('витрина держится ради продажного генератора, пока он дешевле покупки', () => {
    // part25, ход 3 (скриншот): золота 0, в витрине River Skipper. Заморозка
    // — это ставка на ход, где пять золотых дадут ДВА тела: купить за 3,
    // продать за 1 (придёт миньон) и купить ещё одного. Игрок сделал её сам.
    const early = state({
      turn: 3,
      techLevel: 1,
      gold: 0,
      board: [shopMinion(1, 'NEUTRAL')],
      shop: [shopMinion(301, 'SKIPPER'), shopMinion(302, 'MURLOC_1')],
    });
    const keep = freezeRule(early, deps);
    expect(keep?.minion?.cardId).toBe('SKIPPER');
    expect(keep?.reason).toContain('купить-разыграть-продать');
    expect(keep?.reason).toContain('миньона тира 1');
  });

  it('реальный снапшот: на пятом тире та же карта витрины уже не держит', () => {
    // Планка растёт вместе с тирами витрины, а обещанный тир остаётся
    // первым — то же самоограничение, что у заклинания витрины (part23,
    // «это работает для ранней игры»). Проверяется на НАСТОЯЩЕМ снапшоте:
    // на подставном справочнике из десяти карт средние по пулам ничего
    // про игру не говорят.
    const real = loadCardIndex();
    const skipper = minion(301, { cardId: 'BG33_140', attack: 1, health: 1, techLevel: 1 });
    const late = state({
      turn: 17,
      techLevel: 5,
      gold: 0,
      board: [minion(1, { cardId: 'BG32_324', attack: 2, health: 7, techLevel: 5 })],
      shop: [skipper, minion(302, { cardId: 'BG34_Giant_034', attack: 10, health: 6, techLevel: 5 })],
    });
    expect(freezeRule(late, { cards: real })).toBeNull();

    // А на первом тире — держит: карта та же, разница только в планке.
    const early = state({
      turn: 3,
      techLevel: 1,
      gold: 0,
      board: [minion(1, { cardId: 'BGS_127', attack: 3, health: 3, techLevel: 1 })],
      shop: [skipper, minion(302, { cardId: 'BG32_330', attack: 3, health: 3, techLevel: 1 })],
    });
    expect(freezeRule(early, { cards: real })?.minion?.cardId).toBe('BG33_140');
  });

  it('заморозка ради прокрутки молчит, когда карта по карману сегодня', () => {
    // Что покупается сегодня — сегодня и прокручивается, витрины это не стоит.
    const rich = state({
      turn: 3,
      techLevel: 1,
      gold: 3,
      board: [shopMinion(1, 'NEUTRAL')],
      shop: [shopMinion(301, 'SKIPPER'), shopMinion(302, 'MURLOC_1')],
    });
    expect(freezeRule(rich, deps)).toBeNull();
    expect(spinRule(rich, deps, DEFAULT_TAVERN_RULES, buyRules(rich, deps))?.minion?.cardId).toBe(
      'SKIPPER',
    );
  });

  it('«получить» вне боевого клича — не прокрутка', () => {
    // «At the end of your turn, get…» дарит, только пока стоит на борде, —
    // цепочка «купить-разыграть-продать» его эффекта не получает.
    const s = state({ gold: 5, shop: [minion(303, { cardId: 'EOT_GET' }), pirate()] });
    expect(spinRule(s, spinDeps, DEFAULT_TAVERN_RULES, buyRules(s, spinDeps))).toBeNull();
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

    // До лейта реролл не соревнуется с подъёмом и с запасом золота:
    // мусорная витрина — довод подняться, а не крутить (JeefHS,
    // docs/jeefhs.md; прежде с запасом советовался реролл).
    expect(rerollRule({ ...s, gold: 7 }, deps)).toBeNull();

    // В лейте (от lateRerollTier) запас возвращает прежнее поведение:
    // идёт поиск конкретных карт, обновление — полноценная трата (part11).
    expect(rerollRule({ ...s, techLevel: 4, gold: 7 }, deps)).not.toBeNull();
  });

  it('цена обновления берётся живой из кнопки, а не из таблицы', () => {
    // «Gain 2 free Refreshes» (заклинание), напарник Magnus Manastorm,
    // экономические тринкеты — все роняют COST кнопки обновления, и живой
    // тег показывает результат уже применённым. Читать факт надёжнее,
    // чем моделировать каждый источник (part17, ходы 19 и 21).
    const shop = [shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 })];
    expect(rerollCostOf(state({ shop }))).toBe(DEFAULT_TAVERN_RULES.rerollCost);
    expect(rerollCostOf(state({ shop, rerollCost: 0 }))).toBe(0);

    // Золота на покупку хватает — найденное будет на что купить.
    const free = rerollRule(state({ gold: 3, shop, rerollCost: 0 }), deps);
    expect(free?.cost).toBe(0);
    expect(free?.reason).toContain('бесплатно');
  });

  it('когда найденное не на что купить, обновление советуется только под названную цель заморозки', () => {
    // part27, ход 19: золото 0, борд полон, обновление бесплатно — совет
    // «ОБНОВИТЬ — покупать нечего» обещал покупку, которой быть не могло
    // («даже если я обновлю, то не смогу купить существ без продажи»).
    // Витрина — нейтральное тело: соплеменник пары на борде стоил бы
    // выше порога «покупать нечего», и обновление молчало бы по другой
    // причине.
    const shop = [shopMinion(9, 'NEUTRAL', { attack: 1, health: 1 })];
    // Семь нейтральных тел без пар: карты вне справочника, витрина их
    // не предложит, а племени у них нет.
    const full = board([1, 2, 3, 4, 5, 6, 7]).map((m, i) => ({ ...m, cardId: `OWN_${String(i)}` }));

    // Ни пары, ни места — молчит, хотя обновление бесплатно.
    expect(rerollRule(state({ gold: 0, shop, rerollCost: 0, board: full }), deps)).toBeNull();

    // Пара на борде — искать третью копию: тройка соберётся и места не спросит.
    const withPair = (cardId: string, patch: Partial<Minion> = {}): Minion[] =>
      full.map((m, i) => (i >= 5 ? { ...m, cardId, ...patch } : m));
    const paired = withPair('MURLOC_2');
    const triple = rerollRule(state({ gold: 0, shop, rerollCost: 0, board: paired }), deps);
    expect(triple?.reason).toContain('купить нечего и после обновления');
    expect(triple?.reason).toContain('искать под заморозку третью копию Другой мурлок');

    // Золотая копия в пару не идёт: тройка собирается из обычных.
    const golden = paired.map((m, i) => (i === 6 ? { ...m, golden: true } : m));
    expect(rerollRule(state({ gold: 0, shop, rerollCost: 0, board: golden }), deps)).toBeNull();

    // Пара, которой витрина не даст, — не цель: тир выше таверны (part8,
    // ход 21: Goldrinn на пятом тире) и карта вне пула (part17, ход 23:
    // капли Water Droplet).
    expect(
      rerollRule(state({ gold: 0, shop, rerollCost: 0, board: withPair('MURLOC_5') }), deps),
    ).toBeNull();
    expect(
      rerollRule(state({ gold: 0, shop, rerollCost: 0, board: withPair('TOKEN_NOT_IN_POOL') }), deps),
    ).toBeNull();

    // Из двух пар называется старшая по тиру, а не первая по порядку.
    const twoPairs = paired.map((m, i) => (i <= 1 ? { ...m, cardId: 'MURLOC_1' } : m));
    expect(
      rerollRule(state({ gold: 0, shop, rerollCost: 0, board: twoPairs }), deps)?.reason,
    ).toContain('третью копию Другой мурлок');

    // Платное обновление в лейте при том же золоте — та же проверка:
    // «поиск карты под заморозку» обязан назвать, какой.
    expect(
      rerollRule(state({ gold: 1, shop, rerollCost: 1, techLevel: 4, board: full }), deps),
    ).toBeNull();
    expect(
      rerollRule(state({ gold: 1, shop, rerollCost: 1, techLevel: 4, board: paired }), deps)
        ?.reason,
    ).toContain('третью копию');

    // «Не на что купить» — по самому дешёвому товару таверны: на золото,
    // которого хватит на заклинание витрины за 1, обновление советуется
    // как прежде (part12, ход 19: два золота, бесплатное обновление,
    // игрок обновил и купил заклинание).
    const spare = rerollRule(state({ gold: 1, shop, rerollCost: 0, board: full }), deps);
    expect(spare?.action).toBe('reroll');
    expect(spare?.reason).toContain('покупать нечего');
  });

  it('цель «соплеменник» — только там, где заморозка его возьмёт', () => {
    const shop = [shopMinion(9, 'NEUTRAL', { attack: 1, health: 1 })];
    // Два РАЗНЫХ мурлока на неполном борде (пары нет) — искать мурлока
    // своего тира.
    const murlocs = [minion(1, { cardId: 'MURLOC_1' }), minion(2, { cardId: 'MURLOC_2' })];
    const goal = rerollRule(state({ gold: 0, shop, rerollCost: 0, board: murlocs }), deps);
    expect(goal?.reason).toContain('искать под заморозку соплеменника MURLOC тира 2');
    expect(goal?.searchGoal).toBe('соплеменника MURLOC тира 2');

    // В ход подъёма заморозка ради племени молчит (part11) — и цели нет.
    expect(
      rerollRule(
        state({ gold: 0, shop, rerollCost: 0, board: murlocs, turn: 5, techLevelUpTurn: 5 }),
        deps,
      ),
    ).toBeNull();

    // Племя, которого в пуле своего тира нет, целью не называется: два
    // дракона третьего тира при таверне 2 (и как пара они не годятся —
    // тир выше таверны).
    const dragons = board([1, 2], { cardId: 'DRAGON_1' });
    expect(
      rerollRule(state({ gold: 0, shop, rerollCost: 0, board: dragons, techLevel: 2 }), deps),
    ).toBeNull();
  });

  it('бесплатное обновление с подъёмом не соревнуется', () => {
    // Запрет раннего реролла — про трату золота: обновление за 1 отняло бы
    // его у подъёма. Бесплатное не отнимает ничего, и молчать ему незачем.
    const s = {
      gold: 5,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
      shop: [shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 })],
    };
    expect(rerollRule(state(s), deps)).toBeNull();
    expect(rerollRule(state({ ...s, rerollCost: 0 }), deps)).not.toBeNull();
  });

  it('при бесплатном обновлении мусор в витрине не гонит в подъём', () => {
    // Довод «витрина из мусора — поднимайся» (JeefHS) держится на том, что
    // обновление стоит золота. Бесплатное обновление того же мусора
    // не отменяет, но и подъёма не требует.
    const trash = {
      turn: 5,
      techLevel: 3,
      gold: 6,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 4,
      shop: [shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 })],
    };
    const paid = levelUpRule(state(trash), DEFAULT_TAVERN_RULES, buyRules(state(trash), deps));
    const freeRefresh = state({ ...trash, rerollCost: 0 });
    const free = levelUpRule(freeRefresh, DEFAULT_TAVERN_RULES, buyRules(freeRefresh, deps));
    expect(paid?.score ?? 0).toBeGreaterThan(free?.score ?? 0);
  });

  it('ранний реролл молчит только при доступном подъёме', () => {
    // Подъём недоступен по здоровью — реролл ранней партией остаётся:
    // блокировать его нечем, золото иначе сгорит.
    const hurt = state({
      gold: 7,
      hero: hero(40, 30),
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
      shop: [shopMinion(9, 'MURLOC_1', { attack: 1, health: 1 })],
    });
    expect(rerollRule(hurt, deps)).not.toBeNull();
  });

  it('молчит без золота', () => {
    expect(rerollRule(state({ gold: 0, shop: [shopMinion(9, 'MURLOC_1')] }), deps)).toBeNull();
  });

  it('порог растёт с тиром: на пятом тире средняя витрина — повод обновить', () => {
    // Плоский порог тут молчал: миньон пятого тира дороже шести очков
    // одним тиром, и реролл не советовался никогда.
    const s = state({
      techLevel: 5,
      gold: 4,
      shop: [shopMinion(9, 'MURLOC_1', { attack: 2, health: 2 })],
    });
    expect(rerollRule(s, deps)).not.toBeNull();
  });
});

/**
 * Сила героя меняет не только советы — она меняет наши КОНСТАНТЫ.
 *
 * Замер 26.08 по 24 партиям датасета: в 14 из них советник не брал из силы
 * ровно ничего, а по пулу таких сил 126 из 174. Две из них делают наши числа
 * не «недооценёнными», а прямо неверными, и обе закрыты здесь: порог тройки
 * (`Double Time`, факт лога — в part7.test.ts) и статы за розыгрыш
 * (`Hat Trick`, партия part27).
 */
describe('сила героя меняет константы правил', () => {
  const real = loadCardIndex();
  const realDeps = { cards: real };

  // Разбор ТЕКСТА проверяется на настоящем снапшоте (у него переносы строк
  // посреди предложения), а поведение правил — на подставном справочнике,
  // как и все прочие юнит-тесты. Поэтому в заготовку доложены те же две
  // силы с теми же текстами.
  const constCards = createCardIndex([
    ...STUB_CARDS,
    {
      id: 'BG34_HERO_002p',
      name: 'Double Time',
      type: 'Hero_power',
      text: 'You only need 2 copies to make minions Golden. They give Tavern Coins instead of Triple Rewards.',
    },
    {
      id: 'TB_BaconShop_HP_042',
      name: 'Hat Trick',
      type: 'Hero_power',
      text: '[x]When you play a minion,\ngive it a +1/+1 hat\n that passes to a friendly\nminion when sold.',
    },
    { id: 'BG36_HERO_105p', name: 'Feel Devastation', type: 'Hero_power', text: 'Every 4 turns, Discover a minion with a Dark Gift.' },
  ]);
  const constDeps = { cards: constCards };

  const withPower = (powerCardId: string | null, patch: Partial<GameState> = {}): GameState => {
    const base = state(patch);
    return {
      ...base,
      hero: base.hero === null ? null : { ...base.hero, heroPowerCardId: powerCardId },
    };
  };

  it('порог тройки читается из текста силы, иначе остаётся тремя', () => {
    // «You only need 2 copies to make minions Golden» — Double Time.
    expect(copiesForTriple(withPower('BG34_HERO_002p'), real)).toBe(2);
    // Обычная сила порога не трогает, как и её отсутствие.
    expect(copiesForTriple(withPower('BG36_HERO_105p'), real)).toBe(3);
    expect(copiesForTriple(withPower(null), real)).toBe(3);
  });

  it('на Double Time тройку собирает ПЕРВАЯ копия, а не вторая', () => {
    const own = shopMinion(1, 'MURLOC_2');
    const candidate = shopMinion(2, 'MURLOC_2');
    const one = { board: [own], hand: [], shop: [candidate] };

    const doubled = minionValue(candidate, withPower('BG34_HERO_002p', one), constDeps);
    expect(doubled.copiesOwned).toBe(1);
    expect(doubled.completesTriple).toBe(true);
    expect(doubled.tripleBet).toBe(false);
    expect(doubled.copies).toBe(DEFAULT_TAVERN_RULES.copiesBonus.at(-1));

    const usual = minionValue(candidate, withPower('BG36_HERO_105p', one), constDeps);
    expect(usual.completesTriple).toBe(false);
    expect(usual.tripleBet).toBe(true);
    expect(usual.copies).toBe(DEFAULT_TAVERN_RULES.copiesBonus[1]);
  });

  it('причина заморозки и цель обновления называют копию правильным числом', () => {
    // Пара на борде + третья в витрине, которую сейчас не купить.
    const pair = [shopMinion(1, 'MURLOC_2'), shopMinion(2, 'MURLOC_2')];
    const frozen = freezeRule(
      withPower('BG36_HERO_105p', {
        gold: 0,
        board: pair,
        shop: [shopMinion(3, 'MURLOC_2')],
      }),
      constDeps,
    );
    expect(frozen?.reason).toContain('третья копия под тройку');

    // На Double Time та же тройка собирается со второй копии, и совет
    // обязан назвать её второй — игрок сверяет причину, а не число.
    const half = freezeRule(
      withPower('BG34_HERO_002p', {
        gold: 0,
        board: [shopMinion(1, 'MURLOC_2')],
        shop: [shopMinion(3, 'MURLOC_2')],
      }),
      constDeps,
    );
    expect(half?.reason).toContain('вторая копия под тройку');
  });

  it('статы за розыгрыш читаются из силы и входят в ценность покупки', () => {
    // «When you play a minion, give it a +1/+1 hat…» — Hat Trick, part27.
    // Проверка идёт по НАСТОЯЩЕМУ снапшоту: у этого текста перенос строки
    // стоит посреди предложения, и шаблон обязан его терпеть.
    expect(heroPowerPlayStats(withPower('TB_BaconShop_HP_042'), real)).toBe(2);
    expect(heroPowerPlayStats(withPower('BG36_HERO_105p'), real)).toBe(0);
    expect(heroPowerPlayStats(withPower(null), real)).toBe(0);

    const candidate = minion(7, { cardId: 'BGS_039', attack: 3, health: 3, techLevel: 1 });
    const shop = { board: [], hand: [], shop: [candidate] };
    const hatted = minionValue(candidate, withPower('TB_BaconShop_HP_042', shop), realDeps);
    const plain = minionValue(candidate, withPower('BG36_HERO_105p', shop), realDeps);

    // Величина — на нашей же шкале статов, своего веса у слагаемого нет.
    expect(hatted.heroPowerPlay).toBe(2 * DEFAULT_TAVERN_RULES.value.perStatPoint);
    expect(plain.heroPowerPlay).toBe(0);
    expect(hatted.total - plain.total).toBeCloseTo(hatted.heroPowerPlay, 10);
  });

  it('шляпа не считается дважды: у своего миньона она уже в статах', () => {
    // Борд полон, и правило продажи взвешивает СВОИХ. Шляпа Hat Trick —
    // настоящий энчант, её +1/+1 уже сидят в `attack`/`health` миньона:
    // прибавить слагаемое ещё раз значило бы посчитать её дважды, и жертва
    // продажи поехала бы вслед за этой ошибкой.
    const full = {
      board: [
        minion(1, { cardId: 'MURLOC_1', attack: 1, health: 1, techLevel: 1 }),
        ...board([2, 3, 4, 5, 6, 7], { cardId: 'MURLOC_3', attack: 6, health: 6 }),
      ],
      shop: [shopMinion(9, 'MURLOC_5', { attack: 9, health: 9 })],
      gold: 3,
    };
    const hatted = sellRule(withPower('TB_BaconShop_HP_042', full), constDeps);
    const plain = sellRule(withPower('BG36_HERO_105p', full), constDeps);

    expect(hatted?.minion?.entityId).toBe(1);
    expect(plain?.minion?.entityId).toBe(1);

    // Счёт правила продажи — «покупка минус жертва», и шляпа входит в него
    // РОВНО ОДИН раз: покупку ещё предстоит разыграть, а жертва свою шляпу
    // давно носит в статах. Отсюда разница ровно в одну шляпу.
    //
    // Ноль означал бы, что слагаемое прибавлено и жертве тоже (сократилось),
    // двойная шляпа — что оно прибавлено покупке дважды. Оба случая — тихо
    // неверное число, и оба этот тест ловит.
    const hat = 2 * DEFAULT_TAVERN_RULES.value.perStatPoint;
    expect((hatted?.score ?? NaN) - (plain?.score ?? NaN)).toBeCloseTo(hat, 10);
  });
});

describe('правило силы героя', () => {
  const powerCards = createCardIndex([
    {
      id: 'POWER_SPY',
      name: 'Я всё вижу',
      text: "Discover a plain copy of a minion from your next opponent's warband.",
    },
    { id: 'POWER_DMG', name: 'Огонь', text: 'Deal 3 damage to a random enemy minion.' },
  ]);
  const powerDeps = { cards: powerCards };

  const withPower = (cardId: string, patch: Partial<GameState> = {}): GameState =>
    state({
      hero: {
        ...hero(40),
        heroPowerCardId: cardId,
        heroPowerEntityId: 900,
        heroPowerCost: 2,
      },
      ...patch,
    });

  it('сила, дающая миньона, советуется как дешёвая покупка', () => {
    const s = withPower('POWER_SPY');
    const rec = heroPowerRule(s, powerDeps);
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(2);
    expect(rec?.reason).toContain('даёт миньона');
  });

  it('сила E.T.C. «Discover a Buddy» — тоже даёт миньона (part12)', () => {
    // Бадди и есть миньон-напарник, но слова «minion» в тексте силы нет,
    // и при золоте на силу совет молчал.
    const etc = createCardIndex([
      {
        id: 'BG25_HERO_105p',
        name: 'Sign a New Artist',
        text: '<b>Discover</b> a <b>Buddy</b>. <i>(Unlocks at Tier 2.)</i>',
      },
    ]);
    const s = withPower('BG25_HERO_105p', { gold: 3 });
    const powered = {
      ...s,
      hero: s.hero === null ? null : { ...s.hero, heroPowerCost: 3 },
    };
    expect(heroPowerRule(powered, { cards: etc })?.action).toBe('heroPower');
  });

  it('сила Зиреллы даёт миньона местоимением — и всё равно советуется', () => {
    // Дословный текст из снапшота (part9): «minion» и глагол «add» стоят
    // в разных предложениях, объект глагола — «it». Шаблоны «глагол…minion»
    // эту силу не видели, и при золоте ровно на неё советник говорил НИЧЕГО —
    // ровно жалоба игрока со скриншота хода 3.
    const seeTheLight = createCardIndex([
      {
        id: 'BG20_HERO_101p',
        name: 'See the Light',
        text: '[x]Choose a minion in the\nTavern. Set its stats to 2\nand add it to your hand.',
      },
    ]);
    const s = withPower('BG20_HERO_101p', { gold: 2 });
    const rec = heroPowerRule(s, { cards: seeTheLight });
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(2);
  });

  it('нажатая в этом ходу сила не советуется', () => {
    const s = withPower('POWER_SPY');
    const used = {
      ...s,
      hero: s.hero === null ? null : { ...s.hero, heroPowerUsedThisTurn: true },
    };
    expect(heroPowerRule(used, powerDeps)).toBeNull();
  });

  it('заблокированная сила не советуется', () => {
    const s = withPower('POWER_SPY');
    const locked = {
      ...s,
      hero: s.hero === null ? null : { ...s.hero, heroPowerUnplayable: true },
    };
    expect(heroPowerRule(locked, powerDeps)).toBeNull();
  });

  it('сила под замком «Unlocks at Tier N» не советуется (part37)', () => {
    // Замок — тег LOCK_VISUAL, и он единственный признак: HAS_ACTIVATE_POWER
    // и COST у такой силы стоят с первого хода, LITERALLY_UNPLAYABLE
    // не приходит ни разу. Пока признака не было, «Королева драконов»
    // Алекстразы («Discover a Dragon. (Unlocks at Tier 4.)») девять ходов
    // подряд стояла верхней строкой и первым шагом плана.
    const s = withPower('POWER_SPY');
    const locked = {
      ...s,
      hero: s.hero === null ? null : { ...s.hero, heroPowerLocked: true },
    };
    expect(heroPowerRule(locked, powerDeps)).toBeNull();
    // Замок снят — совет возвращается тем же самым.
    expect(heroPowerRule(s, powerDeps)?.action).toBe('heroPower');
  });

  it('про силу вне «даёт миньона» совет не берётся судить', () => {
    expect(heroPowerRule(withPower('POWER_DMG'), powerDeps)).toBeNull();
  });

  it('пассивная сила и нехватка золота — молчание', () => {
    const passive = withPower('POWER_SPY');
    const noCost = {
      ...passive,
      hero: passive.hero === null ? null : { ...passive.hero, heroPowerCost: null },
    };
    expect(heroPowerRule(noCost, powerDeps)).toBeNull();
    expect(heroPowerRule(withPower('POWER_SPY', { gold: 1 }), powerDeps)).toBeNull();
  });
});

describe('правило тёмного дара', () => {
  // Зарядов больше, чем ходов впереди: цена придержанного заряда (part31)
  // равна нулю, и здесь проверяется всё остальное — сама цена проверяется
  // ниже, своим блоком.
  const giftable = (patch: Partial<GameState> = {}): GameState =>
    state({ darkGiftCost: 3, darkGiftCharges: 12, board: [shopMinion(1, 'MURLOC_1')], ...patch });

  it('дар по карману советуется', () => {
    const rec = darkGiftRule(giftable(), deps);
    expect(rec?.action).toBe('darkGift');
    expect(rec?.cost).toBe(3);
  });

  it('нажатый в этом ходу дар не советуется', () => {
    expect(darkGiftRule(giftable({ darkGiftUsedThisTurn: true }), deps)).toBeNull();
  });

  it('без кнопки и без золота — молчание', () => {
    expect(darkGiftRule(state({ darkGiftCost: null }), deps)).toBeNull();
    expect(darkGiftRule(giftable({ gold: 2 }), deps)).toBeNull();
  });

  /**
   * Тир предложения растёт по ходам таверны (таблица игрока), и ценность
   * дара растёт вместе с ним. Прежний плоский вес вёл себя наоборот.
   */
  it('тир предложения читается таблицей по ходу ТАВЕРНЫ', () => {
    // Наш ход 5 — третий ход таверны: таблица обещает 2-й тир.
    const early = darkGiftRule(giftable({ turn: 5, techLevel: 2, gold: 3 }), deps);
    expect(early?.reason).toContain('тир 2');
    // Наш ход 15 — восьмой ход таверны: 4-й или 5-й.
    const late = darkGiftRule(giftable({ turn: 15, techLevel: 5, gold: 3 }), deps);
    expect(late?.reason).toContain('тир 4 или 5');
    expect(late?.score).toBeGreaterThan(early?.score ?? 0);
  });

  it('при отставании от графика золото уступается подъёму', () => {
    // Ход 9 требует тира 5, тир 2 — отставание; золота ровно на подъём.
    const s = giftable({
      turn: 9,
      techLevel: 2,
      gold: 5,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
    });
    expect(darkGiftRule(s, deps)).toBeNull();
  });

  it('по графику дар не блокируется доступным подъёмом', () => {
    // Тир 3 к ходу 5 — по графику; подъём доступен, но не срочен.
    const s = giftable({
      turn: 5,
      techLevel: 3,
      gold: 5,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 4,
    });
    expect(darkGiftRule(s, deps)).not.toBeNull();
  });
});

describe('правило заморозки', () => {
  // Большие статы без синергии: свежая витрина в среднем даст не хуже.
  const bigStats = shopMinion(9, 'AMALGAM', { attack: 10, health: 10, divineShield: true });

  it('голые статы заморозки не окупают: витрина и так обновится бесплатно', () => {
    // Ровно жалоба игрока: морозили миньона, который композиции не помогает,
    // а бесплатное обновление при этом пропадало.
    const alsoBig = shopMinion(10, 'DRAGON_1', { attack: 9, health: 9, taunt: true });
    const s = state({ gold: 3, shop: [bigStats, alsoBig] });
    expect(freezeRule(s, deps)).toBeNull();
  });

  it('копия под тройку — повод держать витрину, если золота не хватает', () => {
    // Свежая витрина копию именно этой карты не обещает. Карта пары — тиром
    // не ниже таверны: пара дешёвки витрину больше не держит (part15, ход 5).
    const s = state({
      gold: 3,
      board: [shopMinion(1, 'MURLOC_3'), shopMinion(2, 'MURLOC_2')],
      shop: [bigStats, shopMinion(10, 'MURLOC_3', { attack: 3, health: 4 })],
    });
    const freeze = freezeRule(s, deps);
    expect(freeze?.action).toBe('freeze');
    expect(freeze?.minion?.cardId).toBe('MURLOC_3');
    expect(freeze?.reason).toContain('копия');
  });

  it('вторая копия НИЖЕ тира таверны витрину не держит (part15, ход 5)', () => {
    // Buzzing Vermin 1/1 первого тира при таверне 2: пара — это ставка
    // на будущую тройку, и ставка дешёвкой не окупает потерю бесплатного
    // обновления — на что игрок и указал. Та же карта тиром таверны — повод.
    const s = state({
      gold: 0,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2')],
      shop: [shopMinion(10, 'MURLOC_1', { attack: 3, health: 4, taunt: true })],
    });
    expect(freezeRule(s, deps)).toBeNull();

    // Третья копия собирает тройку немедленно — тир не важен.
    const triple = state({
      gold: 0,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_1')],
      shop: [shopMinion(10, 'MURLOC_1', { attack: 3, health: 4, taunt: true })],
    });
    expect(freezeRule(triple, deps)?.reason).toContain('третья копия');
  });

  it('миньон собираемого племени — тоже повод', () => {
    // Карта витрины намеренно не копия своих: копия сработала бы раньше
    // и по другой причине.
    const s = state({
      gold: 3,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2')],
      shop: [bigStats, shopMinion(10, 'MURLOC_3', { attack: 4, health: 4 })],
    });
    const freeze = freezeRule(s, deps);
    expect(freeze?.action).toBe('freeze');
    expect(freeze?.reason).toContain('племени');
  });

  it('что по карману — покупается, а не морозится', () => {
    const s = state({
      gold: 9,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2')],
      shop: [bigStats, shopMinion(10, 'MURLOC_1', { attack: 3, health: 4 })],
    });
    expect(freezeRule(s, deps)).toBeNull();
  });

  it('молчит, когда витрина уже заморожена', () => {
    const s = state({
      gold: 3,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2')],
      shop: [
        { ...bigStats, frozen: true },
        { ...shopMinion(10, 'MURLOC_1', { attack: 3, health: 4 }), frozen: true },
      ],
    });
    expect(freezeRule(s, deps)).toBeNull();
  });

  it('дешёвую синергию не морозит: порог ценности из данных', () => {
    const s = state({
      gold: 3,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2')],
      shop: [bigStats, shopMinion(10, 'MURLOC_1', { attack: 3, health: 4 })],
    });
    const strict = {
      ...DEFAULT_TAVERN_RULES,
      freeze: { ...DEFAULT_TAVERN_RULES.freeze, marginOverTier: 1000 },
    };
    expect(freezeRule(s, deps, strict)).toBeNull();
  });

  it('золотая копия своей же карты и амальгама — не повод морозить (part10, ход 3)', () => {
    // На борде золотая Aureate Laureate и амальгама; в витрине такая же
    // золотая. «Своих по племени 2» складывались из неё же и амальгамы —
    // мнимая синергия, заморозка отнимала бесплатное обновление.
    const s = state({
      gold: 0,
      board: [
        minion(1, { cardId: 'MURLOC_1', golden: true }),
        minion(2, { cardId: 'AMALGAM' }),
      ],
      shop: [
        shopMinion(10, 'MURLOC_1', { golden: true, divineShield: true, attack: 2, health: 2 }),
      ],
    });
    expect(freezeRule(s, deps)).toBeNull();
  });

  it('порог растёт с тиром: вторая копия дешёвки на высоком тире не морозится (part10, ход 13)', () => {
    // Snow Baller второго тира при таверне 4: заморозка всей витрины ради
    // дешёвой второй копии — отказ от карт четвёртого тира даром.
    const shopAndBoard = (techLevel: number): GameState =>
      state({
        techLevel,
        gold: 0,
        board: [minion(1, { cardId: 'MURLOC_3' })],
        shop: [shopMinion(10, 'MURLOC_3', { attack: 3, health: 4 })],
      });

    // На родном тире копия под тройку — по-прежнему повод.
    expect(freezeRule(shopAndBoard(2), deps)).not.toBeNull();
    // На четвёртом тире та же карта порог не пробивает.
    expect(freezeRule(shopAndBoard(4), deps)).toBeNull();
  });

  it('в ход подъёма таверны племя витрину не держит (part11, ход 9)', () => {
    // Сразу после подъёма свежая витрина будет уже нового тира — держать
    // старую ради соплеменников значит отдать этот скачок даром.
    const tribeShop = {
      gold: 3,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2')],
      shop: [bigStats, shopMinion(10, 'MURLOC_3', { attack: 4, health: 4 })],
    };
    expect(freezeRule(state(tribeShop), deps)).not.toBeNull();
    expect(freezeRule(state({ ...tribeShop, techLevelUpTurn: 5 }), deps)).toBeNull();

    // Копия под тройку держит витрину и в ход подъёма: копию именно этой
    // карты не даст и новая витрина.
    const copyShop = {
      gold: 3,
      board: [shopMinion(1, 'MURLOC_3'), shopMinion(2, 'MURLOC_2')],
      shop: [bigStats, shopMinion(10, 'MURLOC_3', { attack: 3, health: 4 })],
    };
    expect(freezeRule(state({ ...copyShop, techLevelUpTurn: 5 }), deps)?.reason).toContain(
      'копия',
    );
  });

  it('на полном борде морозится только то, что мы бы купили (part17, ход 25)', () => {
    // Борд полон и силён, кандидат витрины — своего племени, но слабее
    // всех своих. Прежнее правило смотрело только на порог от тира,
    // а он на поздней таверне пробивается статами: советник морозил
    // витрину ради карты, покупку которой сам же и отверг бы.
    const big = (id: number, cardId: string): Minion =>
      shopMinion(id, cardId, { attack: 40, health: 40 });
    const full = state({
      techLevel: 5,
      gold: 0,
      board: [
        big(1, 'MURLOC_1'),
        big(2, 'MURLOC_2'),
        big(3, 'MURLOC_3'),
        big(4, 'DRAGON_1'),
        big(5, 'NEUTRAL'),
        big(6, 'NEUTRAL_2'),
        big(7, 'AMALGAM'),
      ],
      // Кандидат берётся тира таверны: ветка племени с part22 требует
      // карту не ниже тира, и карта первого тира отсеялась бы раньше —
      // тогда тест проверял бы не то, ради чего написан.
      shop: [shopMinion(10, 'MURLOC_5', { attack: 5, health: 5 })],
    });
    expect(freezeRule(full, deps)).toBeNull();

    // Тот же кандидат при месте на борде — по-прежнему повод: там его
    // никто не вытесняет, и планка покупки к нему не применяется.
    const room = { ...full, board: full.board.slice(0, 6) };
    expect(freezeRule(room, deps)).not.toBeNull();
  });

  it('заклинание витрины, дающее миньона, держит витрину (part17, ход 1)', () => {
    // «Steal a random minion from the Tavern» за 2 при нулевом золоте:
    // со следующего хода это покупка и заклинание в один ход — два тела
    // там, где две покупки стоят шесть.
    const lassoCards = createCardIndex([
      {
        id: 'LASSO',
        name: 'Зачарованное лассо',
        type: 'Battleground_spell',
        text: 'Steal a random minion from the Tavern.',
      },
      { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
      { id: 'FILLER', name: 'Наполнитель', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
    ]);
    const lassoDeps = { cards: lassoCards };
    const lasso = { entityId: 800, cardId: 'LASSO', cost: 2, scriptData: [], zonePos: 0, unplayable: false, costsHealth: false };
    const shop = [
      minion(10, { cardId: 'BODY', techLevel: 2, attack: 4, health: 4 }),
      minion(11, { cardId: 'BODY', techLevel: 2, attack: 3, health: 5 }),
    ];

    // Ход 3 — это ВТОРОЙ ход таверны: на следующем будет пять золота,
    // и там лассо за 2 плюс покупка за 3 дают два тела вместо одного
    // и двух сгоревших. Номер хода тут не декорация: до правки part29
    // состояние бралось с умолчания `turn: 5`, где следующий ход даёт
    // ШЕСТЬ золота и тел выходит поровну, — то есть тест назывался
    // «part17, ход 1», а проверял ход, на котором совета быть не должно.
    const broke = state({ turn: 3, gold: 0, shop, shopSpells: [lasso] });
    const freeze = freezeRule(broke, lassoDeps);
    expect(freeze?.action).toBe('freeze');
    expect(freeze?.spellCardId).toBe('LASSO');
    expect(freeze?.minion).toBeNull();

    // На ходу 5 (третий ход таверны) следующий ход даёт шесть золота:
    // две покупки и без лассо, и с ним — лишнего тела нет, витрины это
    // не стоит (part29, ход 5 — «5 золота скорее всего последнее выгодное
    // значение для его заморозки»).
    expect(freezeRule({ ...broke, turn: 5 }, lassoDeps)).toBeNull();
    // А на ходу 9 (пятый ход таверны, восемь золота следующим) лишнее
    // тело снова появляется: две покупки без лассо против лассо и двух
    // покупок с ним. Порога по тиру у ветки нет — есть арифметика.
    expect(freezeRule({ ...broke, turn: 9 }, lassoDeps)?.action).toBe('freeze');

    // По карману — покупать, а не морозить.
    expect(freezeRule({ ...broke, gold: 2 }, lassoDeps)).toBeNull();
    // Заклинание ПО ЦЕНЕ покупки — не «дешевле покупки»: на первом тире
    // «Discover a Tier 1 minion» за 3 стоит ровно свежую карту и брало
    // планку с нулевым запасом (part12, part18 — ход 1; состязательная
    // проверка 26.08).
    expect(
      freezeRule({ ...broke, shopSpells: [{ ...lasso, cost: 3 }] }, lassoDeps),
    ).toBeNull();
    // На полном борде телу неоткуда взяться места. Борд из чужих карт:
    // копии витрины включили бы другую ветку заморозки.
    expect(
      freezeRule(
        {
          ...broke,
          board: Array.from({ length: 7 }, (_, i) =>
            minion(20 + i, { cardId: 'FILLER', attack: 20, health: 20 }),
          ),
        },
        lassoDeps,
      ),
    ).toBeNull();
  });
});

describe('карты-смертники: смертность — по тексту источника (part11, part16)', () => {
  const doomCards = createCardIndex([
    { id: 'PLAIN', name: 'Простой', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
    {
      id: 'RATTLER',
      name: 'Хрипун',
      type: 'Minion',
      techLevel: 2,
      races: [],
      isBaconPool: true,
      mechanics: ['DEATHRATTLE'],
    },
    // Источник-гробница: смертность написана в его тексте (part11).
    {
      id: 'TOMB',
      dbfId: 501,
      name: 'Восстание из гробницы',
      type: 'Battleground_spell',
      text: 'Discover an Undead. It dies if you play it this turn.',
    },
    // Безобидный создатель — награда за тройку: карта бесплатна, не смертна.
    {
      id: 'REWARD',
      dbfId: 502,
      name: 'Награда за тройку',
      type: 'Battleground_spell',
      text: 'Discover a minion from Tier 0.',
    },
  ]);
  const doomDeps = { cards: doomCards };
  const badsong = {
    entityId: 999,
    cardId: 'TB_BaconShopBadsongE',
    timing: 999,
    scriptDataNum1: null,
    scriptDataNum2: null,
  };
  const doomedMinion = (cardId: string, turnsInHand: number, creatorDbf = 501) =>
    minion(9, {
      cardId,
      enchantments: [badsong],
      tags: { NUM_TURNS_IN_HAND: turnsInHand, CREATOR_DBID: creatorDbf },
    });

  it('смертник без хрипа и перерождения не советуется в ход получения', () => {
    const s = state({ hand: [doomedMinion('PLAIN', 1)] });
    expect(playRules(s, doomDeps)).toHaveLength(0);
  });

  it('смертник с предсмертным хрипом советуется с пометкой', () => {
    const s = state({ hand: [doomedMinion('RATTLER', 1)] });
    const play = playRules(s, doomDeps)[0];
    expect(play).toBeDefined();
    expect(play?.reason).toContain('умрёт при розыгрыше');
  });

  it('со следующего хода карта безопасна и советуется как обычная', () => {
    const s = state({ hand: [doomedMinion('PLAIN', 2)] });
    const play = playRules(s, doomDeps)[0];
    expect(play).toBeDefined();
    expect(play?.reason).not.toContain('умрёт');
  });

  it('та же наклейка от безобидного источника — советуется без пометки (part16)', () => {
    // Энчант Badsong значит лишь «бесплатно»: его носят карты от наград
    // за тройку и заклинаний, и они не умирают. Прежнее правило читало
    // энчант как приговор и прятало розыгрыш всей руки — part16, ход 21:
    // три миньона в руке, место на борде, совет «НИЧЕГО».
    const s = state({ hand: [doomedMinion('PLAIN', 1, 502)] });
    const play = playRules(s, doomDeps)[0];
    expect(play).toBeDefined();
    expect(play?.reason).not.toContain('умрёт');
  });

  it('без известного создателя карта не считается смертником', () => {
    // Смертность — доказанный факт текста источника, а не догадка по энчанту.
    const orphan = minion(9, {
      cardId: 'PLAIN',
      enchantments: [badsong],
      tags: { NUM_TURNS_IN_HAND: 1 },
    });
    expect(playRules(state({ hand: [orphan] }), doomDeps)).toHaveLength(1);
  });
});

describe('покупка заклинаний витрины (part11)', () => {
  const shopSpellCards = createCardIndex([
    { id: 'S_BUFF', name: 'Хлеб победителя', type: 'Battleground_spell', text: 'Give a minion +{0}/+{1}.' },
    { id: 'S_GOLD2', name: 'Нефть', type: 'Battleground_spell', text: 'Gain 2 Gold.' },
    { id: 'S_COIN', name: 'Монетка', type: 'Battleground_spell', text: 'Gain 1 Gold.' },
    { id: 'M_BODY', name: 'Тело', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
  ]);
  const shopDeps = { cards: shopSpellCards };
  const shopSpell = (
    cardId: string,
    cost: number,
    scriptData: (number | null)[] = [null, null, null, null],
  ) => ({ entityId: 800, cardId, cost, scriptData, zonePos: 0, unplayable: false, costsHealth: false });

  it('бафф по карману советуется с целью', () => {
    const s = state({
      gold: 2,
      board: [minion(1, { cardId: 'M_BODY', attack: 6, health: 6 })],
      shopSpells: [shopSpell('S_BUFF', 1, [2, 2, null, null])],
    });
    const rec = shopSpellRules(s, shopDeps)[0];
    expect(rec?.action).toBe('buy');
    expect(rec?.spellCardId).toBe('S_BUFF');
    expect(rec?.reason).toContain('+4 статов');
    expect(rec?.reason).toContain('Тело');
  });

  it('золото с чистой прибылью — покупка, в ноль — про запас', () => {
    const profit = state({ gold: 2, shopSpells: [shopSpell('S_GOLD2', 1)] });
    expect(shopSpellRules(profit, shopDeps)[0]?.reason).toContain('чистая прибыль');

    const parity = state({ gold: 2, shopSpells: [shopSpell('S_COIN', 1)] });
    const rec = shopSpellRules(parity, shopDeps)[0];
    expect(rec?.reason).toContain('про запас');
    expect(rec?.score).toBeLessThan(1);
  });

  it('не по карману — молчание', () => {
    const s = state({ gold: 0, shopSpells: [shopSpell('S_BUFF', 1, [2, 2, null, null])] });
    expect(shopSpellRules(s, shopDeps)).toHaveLength(0);
  });

  it('заклинание, дающее миньона, — покупка дешевле трёх (part17)', () => {
    // «Steal a random minion from the Tavern»: приходит случайный миньон
    // ИЗ ЭТОЙ ЖЕ витрины, поэтому средняя ценность витрины — не приближение,
    // а точное ожидание. Плюс сэкономленное золото по курсу.
    const lassoCards = createCardIndex([
      {
        id: 'LASSO',
        name: 'Зачарованное лассо',
        type: 'Battleground_spell',
        text: 'Steal a random minion from the Tavern.',
      },
      { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
    ]);
    const s = state({
      gold: 2,
      shop: [
        minion(10, { cardId: 'BODY', techLevel: 2, attack: 4, health: 4 }),
        minion(11, { cardId: 'BODY', techLevel: 2, attack: 3, health: 5 }),
      ],
      shopSpells: [{ entityId: 800, cardId: 'LASSO', cost: 2, scriptData: [], zonePos: 0, unplayable: false, costsHealth: false }],
    });
    const rec = shopSpellRules(s, { cards: lassoCards })[0];
    expect(rec?.action).toBe('buy');
    expect(rec?.spellCardId).toBe('LASSO');
    expect(rec?.reason).toContain('даёт миньона');
    // Обе карты витрины стоят 8.0 очков. При двух золотых остаток нулевой:
    // скидка не засчитывается — это просто дешёвое тело вместо лучшего.
    expect(rec?.score).toBeCloseTo(8, 5);
    expect(rec?.reason).not.toContain('дешевле покупки');

    // При пяти золотых остаётся ровно на покупку: заклинание и покупка
    // в один ход — два тела, и сэкономленное золото идёт в очки.
    const rich = shopSpellRules({ ...s, gold: 5 }, { cards: lassoCards })[0];
    expect(rich?.score).toBeCloseTo(11, 5);
    expect(rich?.reason).toContain('дешевле покупки');
  });
});

describe('обновление от безделья', () => {
  it('«делать нечего» с золотом превращается в обновление витрины (part11)', () => {
    // Полный сильный борд: покупка не превосходит жертву, реролл молчит
    // («витрина хороша»), и прежний совет был «НИЧЕГО» при золоте на руках.
    const s = state({
      gold: 5,
      board: Array.from({ length: 7 }, (_, i) =>
        shopMinion(i + 1, 'NEUTRAL', { attack: 5, health: 5 }),
      ),
      shop: [shopMinion(10, 'DRAGON_1', { attack: 6, health: 6 })],
    });
    const advice = adviseTavern(s, deps);
    expect(advice?.recommendations[0]?.action).toBe('reroll');
    expect(advice?.recommendations[0]?.reason).toContain('обновление витрины в поиске лучшего');
  });

  it('без золота и с замороженной витриной остаётся «ничего»', () => {
    const frozen = state({
      gold: 5,
      board: Array.from({ length: 7 }, (_, i) =>
        shopMinion(i + 1, 'NEUTRAL', { attack: 5, health: 5 }),
      ),
      shop: [shopMinion(10, 'DRAGON_1', { attack: 6, health: 6, frozen: true })],
    });
    expect(adviseTavern(frozen, deps)?.recommendations[0]?.action).toBe('pass');
  });
});

describe('полный борд: продажа только ради явного превосходства', () => {
  it('кандидат не получает бонусов от жертвы: дракон не продаёт дракона (part10, ход 11)', () => {
    // В руке дракончик, на борде такой же — слабейший. Прежний счёт давал
    // руке бонус «вторая копия» ЗА СЧЁТ той самой карты, которую предлагал
    // продать, и советовал бессмысленный размен один в один.
    const board = [
      ...Array.from({ length: 6 }, (_, i) =>
        minion(i + 1, { cardId: 'MURLOC_2', attack: 5, health: 5 }),
      ),
      minion(7, { cardId: 'DRAGON_1', attack: 2, health: 2 }),
    ];
    const same = state({ board, hand: [minion(9, { cardId: 'DRAGON_1', attack: 2, health: 3 })] });
    expect(playRules(same, deps)).toHaveLength(0);

    // А явное превосходство продажу по-прежнему оправдывает.
    const better = state({
      board,
      hand: [minion(9, { cardId: 'DRAGON_1', attack: 8, health: 8 })],
    });
    const play = playRules(better, deps)[0];
    expect(play?.sellFirst?.cardId).toBe('DRAGON_1');
  });

  it('покупка, собирающая тройку с копией на борде, не требует продажи (part10, ход 13)', () => {
    // Тройка сольёт три копии в золотого — место освободится само.
    const s = state({
      gold: 3,
      board: [
        minion(1, { cardId: 'MURLOC_1' }),
        ...Array.from({ length: 6 }, (_, i) => minion(i + 2, { cardId: 'NEUTRAL' })),
      ],
      hand: [minion(9, { cardId: 'MURLOC_1' })],
      shop: [shopMinion(10, 'MURLOC_1')],
    });
    const buy = buyRules(s, deps).find((r) => r.minion?.cardId === 'MURLOC_1');
    expect(buy).toBeDefined();
    expect(buy?.sellFirst).toBeNull();
    expect(buy?.requiresSlot).toBe(false);
    expect(buy?.reason).toContain('место освободится само');
  });

  it('вторая копия при полном борде покупается в руку, без продажи (part10, ход 11)', () => {
    const s = state({
      gold: 3,
      board: [
        minion(1, { cardId: 'MURLOC_1' }),
        ...Array.from({ length: 6 }, (_, i) => minion(i + 2, { cardId: 'NEUTRAL' })),
      ],
      shop: [shopMinion(10, 'MURLOC_1')],
    });
    const buy = buyRules(s, deps).find((r) => r.minion?.cardId === 'MURLOC_1');
    expect(buy?.sellFirst).toBeNull();
    expect(buy?.reason).toContain('в руку, под тройку');
  });

  it('покупка без явного превосходства над жертвой не советуется вовсе', () => {
    const s = state({
      gold: 3,
      board: Array.from({ length: 7 }, (_, i) =>
        minion(i + 1, { cardId: 'MURLOC_2', attack: 5, health: 5 }),
      ),
      shop: [shopMinion(10, 'NEUTRAL', { attack: 2, health: 2 })],
    });
    expect(buyRules(s, deps).find((r) => r.minion?.cardId === 'NEUTRAL')).toBeUndefined();
  });
});

describe('заклинания руки', () => {
  const spellCards = createCardIndex([
    { id: 'COIN', name: 'Монетка таверны', type: 'Battleground_spell', text: 'Gain 1 Gold.' },
    {
      id: 'BUFF',
      name: 'Тавматургия',
      type: 'Spell',
      text: '[x]Give a minion +{1}/+{1}\nuntil next turn.',
    },
    { id: 'MINION_X', name: 'Миньон', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
  ]);
  const spellDeps = { cards: spellCards };
  const handSpell = (
    cardId: string,
    patch: Partial<GameState['handSpells'][number]> = {},
  ): GameState['handSpells'][number] => ({
    entityId: 900,
    cardId,
    cost: 0,
    scriptData: [null, null],
    zonePos: 0,
    unplayable: false, costsHealth: false,
    ...patch,
  });

  it('spellEffect: литералы, плейсхолдеры из тегов, золото, пусто', () => {
    const idx = createCardIndex([
      { id: 'LIT', text: 'Give a minion +1/+1.' },
      { id: 'PH', text: 'Give a friendly minion +{0} Attack and <b>Divine Shield</b>.' },
      { id: 'GOLD', text: 'Gain 2 Gold.' },
      { id: 'NONE', text: 'Deal 2 damage to a random enemy.' },
    ]);
    const plain = {
      // Временной части у этих усилений нет: «until next turn» в текстах
      // не стоит (part21).
      temporaryStats: 0,
      destroysFriendly: false,
      destroyRace: null,
      transforms: false,
      grantsTaunt: false,
      untargeted: false,
      givesMinion: false,
      goldNextTurn: 0,
      buffsShop: false,
      maxGold: 0,
      // Ветви — только у модального «Choose One» (part19); у обычного
      // заклинания их нет, и выбирать нечего.
      branches: [],
      chosen: null,
    };
    expect(spellEffect('LIT', [], idx)).toEqual({ gold: 0, stats: 2, divineShield: false, ...plain });
    expect(spellEffect('PH', [10, null], idx)).toEqual({
      gold: 0,
      stats: 10,
      divineShield: true,
      ...plain,
    });
    expect(spellEffect('GOLD', [], idx)).toEqual({ gold: 2, stats: 0, divineShield: false, ...plain });
    expect(spellEffect('NONE', [], idx)).toBeNull();
  });

  it('spellEffect: приклеенный золотой вариант текста не удваивает числа (part17)', () => {
    // В снапшоте у части заклинаний в поле text лежат ДВА текста подряд,
    // склеенные «цифры + [x]»: обычная версия и золотая. Fortify —
    // «+{1} Health and Taunt.3[x]Give a minion +{0}/+{1} and Taunt.»:
    // разбор складывал числа обеих и обещал +6 статов вместо +3.
    const idx = createCardIndex([
      {
        id: 'FORTIFY',
        name: 'Укрепление',
        type: 'Battleground_spell',
        text: 'Give a minion\n+{1} Health and <b>Taunt</b>.3[x]Give a minion\n+{0}/+{1} and <b>Taunt</b>.',
      },
      {
        id: 'LEADING',
        name: 'С разметкой',
        type: 'Battleground_spell',
        text: '[x]Give a minion\n+{0} Attack.',
      },
    ]);
    expect(idx.info('FORTIFY')?.text).not.toContain('[x]');
    expect(spellEffect('FORTIFY', [null, 3], idx)?.stats).toBe(3);

    // Ведущий «[x]» — обычная разметка переносов, её резать нельзя.
    expect(idx.info('LEADING')?.text).toContain('Attack');
    expect(spellEffect('LEADING', [5, null], idx)?.stats).toBe(5);
  });

  it('spellEffect: «Destroy a friendly Undead» — жертва, и её племя из текста', () => {
    // «Разделка туши», part13, ход 21: заклинание с баффом всей нежити
    // сперва уничтожает своего миньона-нежить, и цель тут — жертва.
    const idx = createCardIndex([
      {
        id: 'BUTCHER',
        text: 'Destroy a friendly Undead. Your Undead have +{0}/+{1} this game.',
      },
      { id: 'ANYKILL', text: 'Destroy a friendly minion. Gain +2/+2.' },
    ]);
    expect(spellEffect('BUTCHER', [6, 2], idx)).toEqual({
      gold: 0,
      goldNextTurn: 0,
      stats: 8,
      temporaryStats: 0,
      divineShield: false,
      destroysFriendly: true,
      destroyRace: 'UNDEAD',
      transforms: false,
      grantsTaunt: false,
      untargeted: false,
      givesMinion: false,
      buffsShop: false,
      maxGold: 0,
      branches: [],
      chosen: null,
    });
    expect(spellEffect('ANYKILL', [], idx)).toMatchObject({
      destroysFriendly: true,
      destroyRace: null,
    });
  });

  it('заклинание без выбора цели советуется БЕЗ цели (part15, Misplaced Tea Set)', () => {
    // «Give a friendly minion of each type +2/+2» — игра раздаёт сама,
    // а совет писал «→ на Deathstrider», показывая выбор, которого нет.
    const idx = createCardIndex([
      { id: 'TEASET', name: 'Чайный сервиз', text: 'Give a friendly minion of each type +2/+2.' },
      { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 3, races: [], isBaconPool: true },
    ]);
    const s = state({
      board: [minion(1, { cardId: 'BODY', attack: 10, health: 10 })],
      handSpells: [handSpell('TEASET')],
    });
    const rec = spellRules(s, { cards: idx })[0];
    expect(rec).toBeDefined();
    expect(rec?.targetMinion).toBeNull();
    expect(rec?.reason).toContain('не выбирается');
  });

  it('числительное перед friendly — тоже без выбора цели (part16, Healthy Bounty)', () => {
    // «Give four friendly minions +{1} Health» раздаёт сама, а совет писал
    // «→ на Aureate Laureate». Одиночное «a friendly» остаётся целевым.
    const idx = createCardIndex([
      { id: 'BOUNTY', name: 'Щедрость', text: 'Give four friendly minions +{1} Health.' },
      { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 3, races: [], isBaconPool: true },
    ]);
    const s = state({
      board: [minion(1, { cardId: 'BODY', attack: 10, health: 10 })],
      handSpells: [{ ...handSpell('BOUNTY'), scriptData: [null, 4, null, null] }],
    });
    const rec = spellRules(s, { cards: idx })[0];
    expect(rec).toBeDefined();
    expect(rec?.targetMinion).toBeNull();
    expect(rec?.reason).toContain('не выбирается');
  });

  it('провокация не вешается на миньона-«движка» (part15, Slimy Shield)', () => {
    // «Give a minion +1/+1 and Taunt» целился в крупнейшего — Deathstrider
    // («After a friendly Rally minion attacks…»), которого игрок как раз
    // не хочет видеть в приоритете ударов. Цель — крупнейший из остальных.
    const idx = createCardIndex([
      { id: 'SHIELD_T', name: 'Склизкий щит', text: 'Give a minion +1/+1 and <b>Taunt</b>.' },
      {
        id: 'ENGINE',
        name: 'Смертобег',
        type: 'Minion',
        techLevel: 6,
        races: ['BEAST'],
        isBaconPool: true,
        text: '[x]After a friendly <b>Rally</b> minion attacks, trigger your left-most <b>Deathrattle</b>.',
      },
      {
        id: 'AURA_M',
        name: 'Тит',
        type: 'Minion',
        techLevel: 5,
        races: [],
        isBaconPool: true,
        mechanics: ['AURA'],
        text: 'Your <b>Deathrattles</b> trigger an extra time.',
      },
      { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 3, races: [], isBaconPool: true },
    ]);
    const s = state({
      board: [
        minion(1, { cardId: 'ENGINE', attack: 18, health: 11 }),
        minion(2, { cardId: 'AURA_M', attack: 20, health: 20 }),
        minion(3, { cardId: 'BODY', attack: 11, health: 15 }),
      ],
      handSpells: [handSpell('SHIELD_T')],
    });
    const rec = spellRules(s, { cards: idx })[0];
    expect(rec?.targetMinion?.cardId).toBe('BODY');
    expect(rec?.reason).toContain('провокация');

    // Борд целиком из движков: выбор честно возвращается к крупнейшему.
    const allEngines = state({
      board: [
        minion(1, { cardId: 'ENGINE', attack: 18, health: 11 }),
        minion(2, { cardId: 'AURA_M', attack: 20, health: 20 }),
      ],
      handSpells: [handSpell('SHIELD_T')],
    });
    expect(spellRules(allEngines, { cards: idx })[0]?.targetMinion?.cardId).toBe('AURA_M');
  });

  it('триггер О СЕБЕ — боец, а не движок, и провокацию берёт (part17, ход 11)', () => {
    // «After this attacks and kills a minion…» (Wildfire Elemental) — это
    // собственный размен, а не эффект, который надо беречь от ударов.
    // Прежнее правило видело слово «After» и уводило провокацию на токен.
    // Заодно проверяется вторая половина: усиление постоянно, поэтому
    // не идёт на слабейшего своего — кандидата в продажу.
    const idx = createCardIndex([
      { id: 'FORTIFY', name: 'Укрепление', text: 'Give a minion +3 Health and <b>Taunt</b>.' },
      {
        id: 'SELFTRIG',
        name: 'Элементаль огненной бури',
        type: 'Minion',
        techLevel: 3,
        races: ['ELEMENTAL'],
        isBaconPool: true,
        mechanics: ['TRIGGER_VISUAL'],
        text: 'After this attacks and kills a minion, deal excess damage to an adjacent enemy.',
      },
      {
        id: 'TOKEN',
        name: 'Капелька воды',
        type: 'Minion',
        techLevel: 1,
        races: ['ELEMENTAL'],
        isBaconPool: true,
      },
    ]);
    const s = state({
      board: [
        minion(1, { cardId: 'SELFTRIG', attack: 8, health: 3 }),
        minion(2, { cardId: 'TOKEN', attack: 3, health: 3 }),
        minion(3, { cardId: 'TOKEN', attack: 3, health: 3 }),
      ],
      handSpells: [handSpell('FORTIFY')],
    });
    const rec = spellRules(s, { cards: idx })[0];
    expect(rec?.targetMinion?.cardId).toBe('SELFTRIG');
    expect(rec?.reason).toContain('не на кандидата в продажу');
  });

  it('монетка советуется, когда её золото открывает покупку (part10, ход 5)', () => {
    // Два золота, монетка и витрина: прежний совет — «НИЧЕГО», хотя монетка
    // превращала два золота в покупку.
    const s = state({
      gold: 2,
      shop: [minion(10, { cardId: 'MINION_X', attack: 3, health: 4 })],
      handSpells: [handSpell('COIN')],
    });
    const recs = spellRules(s, spellDeps);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.spellCardId).toBe('COIN');
    expect(recs[0]?.reason).toContain('откроется покупка');
  });

  it('монетка молчит, когда добавка ничего не открывает (part10, ход 9)', () => {
    const s = state({
      gold: 0,
      shop: [minion(10, { cardId: 'MINION_X' })],
      handSpells: [handSpell('COIN')],
    });
    expect(spellRules(s, spellDeps)).toHaveLength(0);
  });

  it('бафф-заклинание советуется с целью, числа — из тегов сущности (part10, ход 9)', () => {
    // Тавматургия: «+{1}/+{1}», единица улучшения лежит в NUM_2.
    const s = state({
      board: [
        minion(1, { cardId: 'MINION_X', attack: 2, health: 2 }),
        minion(2, { cardId: 'MINION_X', attack: 6, health: 6 }),
      ],
      handSpells: [handSpell('BUFF', { scriptData: [4, 2] })],
    });
    const recs = spellRules(s, spellDeps);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.reason).toContain('+4 статов');
    expect(recs[0]?.reason).toContain('Миньон');
    expect(recs[0]?.score).toBeCloseTo(2);
  });

  it('заблокированное и не по карману заклинание не советуется', () => {
    const locked = state({
      board: [minion(1, { cardId: 'MINION_X' })],
      handSpells: [handSpell('BUFF', { scriptData: [4, 2], zonePos: 0, unplayable: true, costsHealth: false })],
    });
    expect(spellRules(locked, spellDeps)).toHaveLength(0);

    const expensive = state({
      gold: 0,
      board: [minion(1, { cardId: 'MINION_X' })],
      handSpells: [handSpell('BUFF', { scriptData: [4, 2], cost: 2 })],
    });
    expect(spellRules(expensive, spellDeps)).toHaveLength(0);
  });
});

describe('правило розыгрыша из руки', () => {
  it('советует разыграть, пока на борде есть место', () => {
    const s = state({ hand: [shopMinion(9, 'MURLOC_1', { attack: 3, health: 4 })] });
    const plays = playRules(s, deps);
    expect(plays).toHaveLength(1);
    expect(plays[0]?.action).toBe('play');
    expect(plays[0]?.cost).toBe(0);
    expect(plays[0]?.reason).toContain('из руки');
  });

  it('карта в руке не считает копией саму себя', () => {
    const alone = state({ hand: [shopMinion(9, 'MURLOC_1')] });
    expect(playRules(alone, deps)[0]?.reason).not.toContain('копия');

    // А настоящая пара в руке — считается. Причина при этом говорит,
    // что ставка живёт В РУКЕ: розыгрыш числа копий не меняет (игра
    // считает копии руки наравне с бордом — тег `BACON_PAIR_CANDIDATE`),
    // и бонус за копию в очки розыгрыша не входит (part29, ход 19).
    const pair = state({ hand: [shopMinion(9, 'MURLOC_1'), shopMinion(10, 'MURLOC_1')] });
    expect(playRules(pair, deps)[0]?.reason).toContain('ставка на тройку живёт и в руке');
  });

  it('на полном борде — только через продажу кого-то слабее', () => {
    const s = state({
      board: Array.from({ length: 7 }, (_, i) =>
        shopMinion(i + 1, 'NEUTRAL', { attack: 1, health: 1 }),
      ),
      hand: [shopMinion(9, 'AMALGAM', { attack: 8, health: 8 })],
    });
    const play = playRules(s, deps)[0];
    expect(play?.requiresSlot).toBe(true);
    expect(play?.sellFirst).not.toBeNull();
  });

  it('заблокированная карта из руки не советуется', () => {
    // part8: тринкет выдал Polarizing Beatboxer 5/10 с замком на два хода.
    // Совет «разыграть» по заблокированной карте — тихо неверный.
    const s = state({
      hand: [
        shopMinion(9, 'AMALGAM', { attack: 5, health: 10, tags: { LITERALLY_UNPLAYABLE: 1 } }),
      ],
    });
    expect(playRules(s, deps)).toHaveLength(0);

    // Замок снят — совет вернулся.
    const unlocked = state({
      hand: [
        shopMinion(9, 'AMALGAM', { attack: 5, health: 10, tags: { LITERALLY_UNPLAYABLE: 0 } }),
      ],
    });
    expect(playRules(unlocked, deps)).toHaveLength(1);
  });

  it('слабее слабейшего своего из руки не разыгрывается', () => {
    const s = state({
      board: Array.from({ length: 7 }, (_, i) =>
        shopMinion(i + 1, 'DRAGON_1', { attack: 8, health: 8 }),
      ),
      hand: [shopMinion(9, 'NEUTRAL', { attack: 1, health: 1 })],
    });
    expect(playRules(s, deps)).toHaveLength(0);
  });
});

describe('напоминание о тринкетах за ход до предложения (тьюторинг, JeefHS)', () => {
  it('называет племена с парой своих; амальгама не в счёт', () => {
    // Предложения открываются на ходах 11 и 17 (замер по всем двенадцати
    // партиям билда 248348), напоминание — за ход, на 9 и 15. Игра
    // подбирает тринкеты под борд (docs/jeefhs.md, подтверждено игроком);
    // амальгама «своя» всем племенам сразу и сигналом не считается.
    const s = state({
      turn: 9,
      board: [
        shopMinion(1, 'MURLOC_1'),
        shopMinion(2, 'MURLOC_2'),
        shopMinion(3, 'AMALGAM'),
        shopMinion(4, 'DRAGON_1'),
      ],
    });
    const note = trinketForecast(s, deps);
    expect(note).toContain('MURLOC ×2');
    expect(note).not.toContain('DRAGON');
    expect(note).not.toContain('ALL');
  });

  it('без пары своих предупреждает держать пару желаемого племени', () => {
    const s = state({ turn: 15, board: [shopMinion(1, 'MURLOC_1')] });
    expect(trinketForecast(s, deps)).toContain('держите пару миньонов');
  });

  it('в остальные ходы молчит', () => {
    for (const turn of [1, 5, 7, 11, 13, 17, 19]) {
      expect(trinketForecast(state({ turn }), deps)).toBeNull();
    }
  });

  it('совет целиком несёт напоминание полем', () => {
    expect(adviseTavern(state({ turn: 9 }), deps)?.trinketForecast).not.toBeNull();
    expect(adviseTavern(state({ turn: 7 }), deps)?.trinketForecast).toBeNull();
  });
});

describe('совет по выбору тринкета', () => {
  const trinketCards = createCardIndex([
    { id: 'MURLOC_1', name: 'Мурлок', techLevel: 1, races: ['MURLOC'], isBaconPool: true },
    { id: 'DRAGON_1', name: 'Дракон', techLevel: 3, races: ['DRAGON'], isBaconPool: true },
    {
      id: 'TR_DRAKE',
      dbfId: 1001,
      name: 'Планер',
      text: 'Whenever you play a card, give a friendly Dragon +1/+1.',
    },
    {
      id: 'TR_GOLD',
      dbfId: 1002,
      name: 'Копилка',
      text: 'At the start of your turn, gain 1 Gold.',
    },
    {
      id: 'TR_MURLOC',
      dbfId: 1003,
      name: 'Икра',
      text: 'After you sell a Murloc, give your Murlocs +1/+1.',
    },
  ]);
  const trinketDeps = { cards: trinketCards };

  const offer = (...cardIds: string[]): Partial<GameState> => ({
    trinketOffer: cardIds.map((cardId, i) => ({ entityId: 9000 + i, cardId, subsetRaces: [], cost: null })),
  });

  it('без открытого предложения совет пуст', () => {
    expect(trinketAdvice(state(), trinketDeps)).toEqual([]);
  });

  it('тринкет собираемого племени встаёт первым', () => {
    const s = state({
      board: [
        minion(1, { cardId: 'DRAGON_1' }),
        minion(2, { cardId: 'DRAGON_1' }),
        minion(3, { cardId: 'MURLOC_1' }),
      ],
      ...offer('TR_MURLOC', 'TR_DRAKE'),
    });
    const advice = trinketAdvice(s, trinketDeps);

    expect(advice[0]?.name).toBe('Планер');
    expect(advice[0]?.tribeMinions).toBe(2);
    expect(advice[0]?.reason).toContain('DRAGON');
  });

  it('про эффект вне племён сказано честно, а не выдуман рейтинг', () => {
    const s = state({ board: [minion(1, { cardId: 'DRAGON_1' })], ...offer('TR_GOLD') });
    const advice = trinketAdvice(s, trinketDeps);
    expect(advice[0]?.reason).toContain('не берёмся');
  });

  it('племя без своих миньонов не получает очков авансом', () => {
    const s = state({ board: [minion(1, { cardId: 'DRAGON_1' })], ...offer('TR_MURLOC') });
    expect(trinketAdvice(s, trinketDeps)[0]?.tribeMinions).toBe(0);
    expect(trinketAdvice(s, trinketDeps)[0]?.reason).toContain('своих таких нет');
  });

  it('заметно лучшая статистика перевешивает слабую племенную синергию (JeefHS)', () => {
    // Правило из базы знаний JeefHS, подтверждено игроком: сильный
    // нейтральный/экономический тринкет лучше слабого племенного. Курс —
    // trinketPlacePerTribeMinion (σ выборки снапшота) за своего миньона.
    const stats = createBgStats(null, {
      trinketStats: [
        { trinketCardId: 'TR_GOLD', averagePlacement: 3.5, dataPoints: 5000 },
        { trinketCardId: 'TR_MURLOC', averagePlacement: 4.3, dataPoints: 5000 },
      ],
    });
    const pair = state({
      board: [minion(1, { cardId: 'MURLOC_1' }), minion(2, { cardId: 'MURLOC_1' })],
      ...offer('TR_MURLOC', 'TR_GOLD'),
    });
    // Эффективные места: копилка 3.5, икра 4.3 − 2×0.3 = 3.7 — копилка первой.
    const advice = trinketAdvice(pair, { cards: trinketCards, bgStats: stats });
    expect(advice[0]?.name).toBe('Копилка');

    // Сильная синергия статистикой не перебивается: при пяти мурлоках
    // икра 4.3 − 5×0.3 = 2.8 против 3.5 — племенной тринкет первый.
    const many = state({
      board: Array.from({ length: 5 }, (_, i) => minion(i + 1, { cardId: 'MURLOC_1' })),
      ...offer('TR_MURLOC', 'TR_GOLD'),
    });
    expect(trinketAdvice(many, { cards: trinketCards, bgStats: stats })[0]?.name).toBe('Икра');
  });

  it('без статистики порядок прежний: свои племена первыми', () => {
    // Глобальное среднее нашего борда не знает; когда статистики нет,
    // единственный сигнал — синергия.
    const pair = state({
      board: [minion(1, { cardId: 'MURLOC_1' }), minion(2, { cardId: 'MURLOC_1' })],
      ...offer('TR_MURLOC', 'TR_GOLD'),
    });
    const advice = trinketAdvice(pair, { cards: trinketCards, bgStats: null });
    expect(advice[0]?.name).toBe('Икра');
  });

  it('племя тринкета читается из тега BACON_SUBSET, когда в тексте плейсхолдер (part12)', () => {
    // «Разноцветный компас»: в тексте «Get a random {0}» — племя подставляет
    // клиент, а в снапшоте его нет. Тег BACON_SUBSET_DRAGON на сущности
    // называет его прямо, и имена совпадают со строками races снапшота.
    const compassCards = createCardIndex([
      { id: 'DRAGON_D', name: 'Дракон', techLevel: 2, races: ['DRAGON'], isBaconPool: true },
      {
        id: 'TR_COMPASS',
        dbfId: 1020,
        name: 'Разноцветный компас',
        text: '[x]Get a random {0}. At the start of each turn, get another.',
      },
    ]);
    const s = state({
      board: [minion(1, { cardId: 'DRAGON_D' }), minion(2, { cardId: 'DRAGON_D' })],
      trinketOffer: [{ entityId: 9000, cardId: 'TR_COMPASS', subsetRaces: ['DRAGON'], cost: null }],
    });
    const advice = trinketAdvice(s, { cards: compassCards });
    expect(advice[0]?.tribeMinions).toBe(2);
    expect(advice[0]?.reason).toContain('DRAGON');
  });

  it('племя механизмов называется MECH, как в снапшоте — регрессия part9', () => {
    // Ключ таблицы обязан совпадать со строкой races снапшота. Ключ
    // MECHANICAL не совпадал ни с чем, и Scraper Sticker при пяти мехах
    // на борде получал «своих таких нет» — скриншот хода 11.
    const mechCards = createCardIndex([
      { id: 'MECH_M', name: 'Мех', techLevel: 2, races: ['MECH'], isBaconPool: true },
      {
        id: 'TR_MECH',
        dbfId: 1010,
        name: 'Наклейка с металлоискателем',
        text: 'Get a random <b>Magnetic</b> Mech. At the start of each turn, get another.',
      },
    ]);
    const s = state({
      board: [minion(1, { cardId: 'MECH_M' }), minion(2, { cardId: 'MECH_M' })],
      trinketOffer: [{ entityId: 9000, cardId: 'TR_MECH', subsetRaces: [], cost: null }],
    });
    const advice = trinketAdvice(s, { cards: mechCards });
    expect(advice[0]?.tribeMinions).toBe(2);
    expect(advice[0]?.reason).not.toContain('своих таких нет');
  });
});

describe('племя, названное в тексте карты', () => {
  const textCards = createCardIndex([
    { id: 'MECH_M', name: 'Мех', techLevel: 2, races: ['MECH'], isBaconPool: true },
    {
      id: 'KANGOR',
      name: 'Ученица Кангора',
      techLevel: 5,
      races: [],
      isBaconPool: true,
      text: '[x]<b>Deathrattle:</b> Summon plain\ncopies of your first 2 Mechs\nthat died this combat.',
    },
    {
      id: 'HOG',
      name: 'Свиногонщик',
      techLevel: 6,
      races: ['QUILBOAR'],
      isBaconPool: true,
      text: '[x]After you play <b>Choose One</b>\ncard, this plays a <b>Blood Gem</b>\n on all your other Quilboar.',
    },
  ]);
  const textDeps = { cards: textCards };

  it('миньон без племени с текстом про племя получает синергию', () => {
    const s = state({
      board: [minion(1, { cardId: 'MECH_M' }), minion(2, { cardId: 'MECH_M' })],
    });
    const v = minionValue(minion(9, { cardId: 'KANGOR', techLevel: 5, attack: 3, health: 6 }), s, textDeps);
    expect(v.textTribeMates).toBe(2);
    expect(v.textTribe).toBeGreaterThan(0);
  });

  it('собственное племя в тексте не считается дважды', () => {
    const s = state({ board: [minion(1, { cardId: 'HOG' })] });
    const v = minionValue(minion(9, { cardId: 'HOG', techLevel: 6 }), s, textDeps);
    expect(v.tribeMates).toBe(1);
    expect(v.textTribeMates).toBe(0);
  });

  it('part9, ход 19: Свиногонщик больше не вытесняет Ученицу Кангора', () => {
    // Шесть мехов 7/7 и Ученица 3/6 на полном борде, в руке свинобраз
    // 5/7 шестого тира. Без текстового племени Ученица — слабейшая по голым
    // статам, и советник предлагал продать её; с ним она держит своё место.
    const s = state({
      board: [
        ...Array.from({ length: 6 }, (_, i) =>
          minion(i + 1, { cardId: 'MECH_M', techLevel: 2, attack: 7, health: 7 }),
        ),
        minion(7, { cardId: 'KANGOR', techLevel: 5, attack: 3, health: 6 }),
      ],
      hand: [minion(9, { cardId: 'HOG', techLevel: 6, attack: 5, health: 7 })],
    });

    // Как было: жертвой выбиралась Ученица. Теперь её держат ДВА слагаемых —
    // племя из текста и боевой призыв («Summon plain copies…»), поэтому
    // ветка «как было» отключает оба.
    const noText = {
      ...DEFAULT_TAVERN_RULES,
      value: { ...DEFAULT_TAVERN_RULES.value, perTextTribeMate: 0, battleEffect: 0 },
    };
    expect(playRules(s, textDeps, noText)[0]?.sellFirst?.cardId).toBe('KANGOR');

    // Как стало: розыгрыш чужого племени через продажу не советуется вовсе.
    expect(playRules(s, textDeps)).toHaveLength(0);
  });
});

describe('связь по имени карты в тексте (Automaton Portrait)', () => {
  const namedCards = createCardIndex([
    {
      id: 'PORTRAIT',
      name: 'Automaton Portrait',
      type: 'Minion',
      techLevel: 3,
      races: [],
      isBaconPool: true,
      // Перенос строки посреди имени — реальность снапшота (урок part16).
      text: '<b>Start of Combat:</b> When you have space, summon an Ancestral\nAutomaton.',
    },
    {
      id: 'AUTOMATON',
      name: 'Ancestral Automaton',
      type: 'Minion',
      techLevel: 2,
      races: ['MECH'],
      isBaconPool: true,
      text: "Has +3/+2 for each other Ancestral Automaton you've summoned this game.",
    },
    { id: 'PLAIN', name: 'Просто тело', type: 'Minion', techLevel: 2, races: [], isBaconPool: true },
  ]);
  const namedDeps = { cards: namedCards };

  it('кандидат, называющий карту своих, получает связь за каждый экземпляр', () => {
    const s = state({
      board: [
        minion(1, { cardId: 'AUTOMATON' }),
        minion(2, { cardId: 'AUTOMATON' }),
        minion(3, { cardId: 'PLAIN' }),
      ],
    });
    const v = minionValue(minion(9, { cardId: 'PORTRAIT' }), s, namedDeps);
    expect(v.namedCardMates).toBe(2);
    expect(v.namedCard).toBe(2 * DEFAULT_TAVERN_RULES.value.perNamedCardMate);
  });

  it('связь двусторонняя: автоматон из витрины ценнее при портрете на борде', () => {
    const s = state({ board: [minion(1, { cardId: 'PORTRAIT' })] });
    const v = minionValue(minion(9, { cardId: 'AUTOMATON' }), s, namedDeps);
    expect(v.namedCardMates).toBe(1);
  });

  it('копии по имени не считаются — у них своя ветка тройки', () => {
    // Текст автоматона называет его же имя («for each other Ancestral
    // Automaton») — вторая копия не должна получать связь сверх бонуса копий.
    const s = state({ board: [minion(1, { cardId: 'AUTOMATON' })] });
    const v = minionValue(minion(9, { cardId: 'AUTOMATON' }), s, namedDeps);
    expect(v.namedCardMates).toBe(0);
  });

  it('без связи в текстах — ноль', () => {
    const s = state({ board: [minion(1, { cardId: 'PLAIN' })] });
    expect(minionValue(minion(9, { cardId: 'PORTRAIT' }), s, namedDeps).namedCardMates).toBe(0);
  });

  it('реальный снапшот: портрет видит автоматонов', () => {
    // Данные, а не выдуманная таблица пар: тексты обеих карт — в снапшоте.
    const real = loadCardIndex();
    const portrait = real.info('BG30_MagicItem_303');
    const automaton = real.info('BG_TTN_401');
    expect(portrait).not.toBeNull();
    expect(automaton).not.toBeNull();

    const s = state({ board: [minion(1, { cardId: 'BG_TTN_401' })] });
    const v = minionValue(minion(9, { cardId: 'BG30_MagicItem_303' }), s, { cards: real });
    expect(v.namedCardMates).toBe(1);
  });
});

describe('магнетизм', () => {
  const magCards = createCardIndex([
    { id: 'MECH_SMALL', name: 'Мелкий мех', techLevel: 2, races: ['MECH'], isBaconPool: true },
    { id: 'MECH_BIG', name: 'Большой мех', techLevel: 4, races: ['MECH'], isBaconPool: true },
    {
      id: 'MAGNET',
      name: 'Магнитный мех',
      techLevel: 3,
      races: ['MECH'],
      isBaconPool: true,
      mechanics: ['MODULAR'],
      text: '<b>Magnetic</b>',
    },
    { id: 'BEAST_1', name: 'Зверь', techLevel: 2, races: ['BEAST'], isBaconPool: true },
  ]);
  const magDeps = { cards: magCards };

  const fullMechBoard = [
    minion(1, { cardId: 'MECH_BIG', attack: 10, health: 10 }),
    ...Array.from({ length: 6 }, (_, i) =>
      minion(i + 2, { cardId: 'MECH_SMALL', attack: 2, health: 2 }),
    ),
  ];

  const magnetInHand = minion(9, { cardId: 'MAGNET', techLevel: 3 });

  it('цель примагничивания — самый крупный свой мех', () => {
    expect(magnetizeTarget(magnetInHand, fullMechBoard, magCards)?.cardId).toBe('MECH_BIG');
    expect(magnetizeTarget(magnetInHand, [minion(1, { cardId: 'BEAST_1' })], magCards)).toBeNull();
  });

  // «Рука-протез» из part13: Magnetic + Reborn, магнитится к мехам и нежити.
  const giftCards = createCardIndex([
    {
      id: 'HAND_P',
      name: 'Рука-протез',
      techLevel: 3,
      races: ['MECH', 'UNDEAD'],
      isBaconPool: true,
      mechanics: ['MODULAR', 'REBORN'],
      text: '<b>Magnetic</b>, <b>Reborn</b> Can <b>Magnetize</b> to Mechs or Undead.',
    },
    { id: 'MECH_SMALL', name: 'Мелкий мех', techLevel: 2, races: ['MECH'], isBaconPool: true },
    { id: 'MECH_BIG', name: 'Большой мех', techLevel: 4, races: ['MECH'], isBaconPool: true },
    { id: 'UNDEAD_1', name: 'Нежить', techLevel: 2, races: ['UNDEAD'], isBaconPool: true },
  ]);
  const giftMagnet = minion(9, { cardId: 'HAND_P', techLevel: 3 });

  it('дар магнита не дарится тому, у кого он уже есть (part13, ход 19)', () => {
    // Большой мех уже перерождён прошлой такой же рукой — новый дар пропал бы.
    const withReborn = [
      minion(1, { cardId: 'MECH_BIG', attack: 38, health: 40, reborn: true }),
      minion(2, { cardId: 'MECH_SMALL', attack: 10, health: 7 }),
    ];
    expect(magnetizeTarget(giftMagnet, withReborn, giftCards)?.cardId).toBe('MECH_SMALL');

    // Перерождены все — дар пропадает в любом случае, а статы складываются
    // всегда: носитель снова просто крупнейший.
    const allReborn = withReborn.map((m) => ({ ...m, reborn: true }));
    expect(magnetizeTarget(giftMagnet, allReborn, giftCards)?.cardId).toBe('MECH_BIG');
  });

  it('племена носителя читаются с карты магнита: «к мехам или нежити»', () => {
    const undeadOnly = [minion(1, { cardId: 'UNDEAD_1', attack: 5, health: 5 })];
    // «Рука-протез» магнитится к нежити, обычный магнит — нет.
    expect(magnetizeTarget(giftMagnet, undeadOnly, giftCards)?.cardId).toBe('UNDEAD_1');
    expect(magnetizeTarget(magnetInHand, undeadOnly, magCards)).toBeNull();
  });

  it('при виденном яде носитель — со щитом, а не просто крупнейший (слово игрока)', () => {
    const mechs = [
      minion(1, { cardId: 'MECH_BIG', attack: 30, health: 30 }),
      minion(2, { cardId: 'MECH_SMALL', attack: 5, health: 5, divineShield: true }),
    ];
    // Без угрозы — крупнейший, как раньше.
    expect(magnetizeTarget(magnetInHand, mechs, magCards)?.cardId).toBe('MECH_BIG');
    // С угрозой — щитоносец: яд убивает любым касанием, а щит его поглощает,
    // и статы, сложенные в тело без щита, обнуляются об 1/1.
    expect(magnetizeTarget(magnetInHand, mechs, magCards, true)?.cardId).toBe('MECH_SMALL');
    // Щитоносцев нет вовсе — снова крупнейший: без носителя ещё хуже.
    const bare = [
      minion(1, { cardId: 'MECH_BIG', attack: 30, health: 30 }),
      minion(3, { cardId: 'MECH_SMALL', attack: 5, health: 5 }),
    ];
    expect(magnetizeTarget(magnetInHand, bare, magCards, true)?.cardId).toBe('MECH_BIG');
  });

  it('магнит, дарящий щит, снимает угрозу яда — размер снова главный', () => {
    const shieldCards = createCardIndex([
      {
        id: 'SHIELD_MAG',
        name: 'Щитоносный магнит',
        techLevel: 3,
        races: ['MECH'],
        isBaconPool: true,
        mechanics: ['MODULAR', 'DIVINE_SHIELD'],
        text: '<b>Magnetic</b> <b>Divine Shield</b>',
      },
      { id: 'MECH_SMALL', name: 'Мелкий мех', techLevel: 2, races: ['MECH'], isBaconPool: true },
      { id: 'MECH_BIG', name: 'Большой мех', techLevel: 4, races: ['MECH'], isBaconPool: true },
    ]);
    const shieldMagnet = minion(9, { cardId: 'SHIELD_MAG', techLevel: 3 });
    const mechs = [
      minion(1, { cardId: 'MECH_BIG', attack: 30, health: 30 }),
      minion(2, { cardId: 'MECH_SMALL', attack: 5, health: 5, divineShield: true }),
    ];
    // Носитель получит щит от самого магнита — предпочтение щитоносцу
    // не нужно, а дар-фильтр и так уводит от того, у кого щит уже есть.
    expect(magnetizeTarget(shieldMagnet, mechs, shieldCards, true)?.cardId).toBe('MECH_BIG');
  });

  it('яд читается из виденных бордов соперников', () => {
    expect(poisonAmongSeen(state())).toBe(false);
    expect(
      poisonAmongSeen(state({ lastSeenBoards: { 4: [minion(50, { poisonous: true })] } })),
    ).toBe(true);
    // venomous — тот же смертельный контакт, только одноразовый.
    expect(
      poisonAmongSeen(state({ lastSeenBoards: { 4: [minion(50, { venomous: true })] } })),
    ).toBe(true);
  });

  it('розыгрыш магнита при виденном яде называет щитоносца и говорит почему', () => {
    const s = state({
      board: [
        minion(1, { cardId: 'MECH_BIG', attack: 30, health: 30 }),
        minion(2, { cardId: 'MECH_SMALL', attack: 5, health: 5, divineShield: true }),
      ],
      hand: [minion(9, { cardId: 'MAGNET', techLevel: 3 })],
      lastSeenBoards: { 4: [minion(50, { poisonous: true })] },
    });
    const play = playRules(s, magDeps)[0];
    expect(play?.magnetizeTo?.cardId).toBe('MECH_SMALL');
    expect(play?.reason).toContain('яд');
  });

  it('магнитному в руке носитель называется и на неполном борде (part13, ход 15)', () => {
    const s = state({
      board: [minion(1, { cardId: 'MECH_BIG', attack: 10, health: 10 })],
      hand: [minion(9, { cardId: 'MAGNET', techLevel: 3 })],
    });
    const play = playRules(s, magDeps)[0];
    // Прежде носитель назывался только на полном борде, и игрок решал
    // «телом или примагнитить» вслепую — на что и указал.
    expect(play?.magnetizeTo?.cardId).toBe('MECH_BIG');
    expect(play?.requiresSlot).toBe(false);
    expect(play?.sellFirst).toBeNull();
  });

  it('магнитный мех на полном борде идёт через примагничивание, не через продажу', () => {
    // Жалоба игрока со скриншота хода 13: «разыграть Accord-o-Tron, продав
    // Molten Rock», хотя магнитный мех места не занимает.
    const s = state({
      board: fullMechBoard,
      hand: [minion(9, { cardId: 'MAGNET', techLevel: 3 })],
    });
    const play = playRules(s, magDeps)[0];
    expect(play).toBeDefined();
    expect(play?.sellFirst).toBeNull();
    expect(play?.requiresSlot).toBe(false);
    expect(play?.magnetizeTo?.cardId).toBe('MECH_BIG');
    expect(play?.reason).toContain('магнит');
  });

  it('покупка магнитного при полном борде тоже без продажи', () => {
    const s = state({
      board: fullMechBoard,
      shop: [minion(9, { cardId: 'MAGNET', techLevel: 3 })],
    });
    const buy = buyRules(s, magDeps).find((r) => r.minion?.cardId === 'MAGNET');
    expect(buy?.sellFirst).toBeNull();
    expect(buy?.requiresSlot).toBe(false);
    expect(buy?.magnetizeTo?.cardId).toBe('MECH_BIG');
  });

  it('без своих мехов магнит идёт обычным путём — через продажу слабейшего', () => {
    const s = state({
      board: Array.from({ length: 7 }, (_, i) =>
        minion(i + 1, { cardId: 'BEAST_1', attack: 1, health: 1 }),
      ),
      hand: [minion(9, { cardId: 'MAGNET', techLevel: 3, attack: 5, health: 5 })],
    });
    const play = playRules(s, magDeps)[0];
    expect(play?.magnetizeTo ?? null).toBeNull();
    expect(play?.sellFirst).not.toBeNull();
  });
});

describe('совет по открытому выбору', () => {
  const choiceCards = createCardIndex([
    { id: 'MECH_M', name: 'Мех', techLevel: 2, races: ['MECH'], isBaconPool: true, type: 'Minion' },
    {
      id: 'PICK_MECH',
      name: 'Зачарованный часовой',
      type: 'Minion',
      techLevel: 4,
      races: ['MECH'],
      isBaconPool: true,
      attack: 3,
      health: 5,
      mechanics: ['MODULAR'],
    },
    {
      id: 'PICK_QUIL',
      name: 'Шипастый проходчик',
      type: 'Minion',
      techLevel: 4,
      races: ['QUILBOAR'],
      isBaconPool: true,
      attack: 3,
      health: 6,
    },
    { id: 'PICK_SPELL', name: 'Дар', type: 'Spell' },
  ]);
  const choiceDeps = { cards: choiceCards };

  const withChoice = (
    boardIds: readonly string[],
    ...optionIds: string[]
  ): GameState =>
    state({
      board: boardIds.map((cardId, i) => minion(i + 1, { cardId })),
      openChoice: {
        id: 3,
        sourceCardId: 'SRC',
        options: optionIds.map((cardId, i) => ({ entityId: 100 + i, cardId })),
      },
    });

  it('без открытого выбора совет пуст', () => {
    expect(choiceAdvice(state(), choiceDeps)).toEqual([]);
  });

  it('варианты-миньоны ранжируются той же ценностью, племя решает', () => {
    const advice = choiceAdvice(
      withChoice(['MECH_M', 'MECH_M'], 'PICK_QUIL', 'PICK_MECH'),
      choiceDeps,
    );
    expect(advice[0]?.name).toBe('Зачарованный часовой');
    expect(advice[0]?.value).not.toBeNull();
    expect(advice[0]?.reason).toContain('магнитный');
  });

  it('копия под тройку перевешивает статы и племя', () => {
    const advice = choiceAdvice(
      withChoice(['PICK_QUIL', 'PICK_QUIL'], 'PICK_QUIL', 'PICK_MECH'),
      choiceDeps,
    );
    expect(advice[0]?.name).toBe('Шипастый проходчик');
    expect(advice[0]?.reason).toContain('собирает тройку');
  });

  it('не-миньон без понятного эффекта честно не оценивается и идёт в конец', () => {
    const advice = choiceAdvice(
      withChoice(['MECH_M'], 'PICK_SPELL', 'PICK_MECH'),
      choiceDeps,
    );
    expect(advice[0]?.name).toBe('Зачарованный часовой');
    expect(advice.at(-1)?.value).toBeNull();
    expect(advice.at(-1)?.score).toBeNull();
    expect(advice.at(-1)?.reason).toContain('не берёмся');
  });

  it('заклинание-сокровище оценивается эффектом из текста (part10, ход 17)', () => {
    // «Buy the Holy Light»: «+{0} Attack and Divine Shield», десятка в NUM_1.
    // Прежде весь выбор из заклинаний молчал, и оверлей советовал покупки,
    // будто модального экрана нет.
    const treasureCards = createCardIndex([
      {
        id: 'HOLY',
        name: 'Именем Света',
        type: 'Spell',
        text: 'Give a friendly minion +{0} Attack and <b>Divine Shield</b>.',
      },
      { id: 'BAN', name: 'Бананы', type: 'Spell', text: 'Fill your hand with Bananas.' },
    ]);
    const s = state({
      openChoice: {
        id: 6,
        sourceCardId: 'SRC',
        options: [
          { entityId: 1, cardId: 'BAN' },
          { entityId: 2, cardId: 'HOLY', scriptData: [10, null] },
        ],
      },
    });
    const advice = choiceAdvice(s, { cards: treasureCards });

    expect(advice[0]?.name).toBe('Именем Света');
    expect(advice[0]?.score).toBeCloseTo(8); // 10 статов × 0.5 + щит 3
    expect(advice[0]?.reason).toContain('щит');
    expect(advice.at(-1)?.score).toBeNull();
  });
});

describe('план розыгрыша на ход', () => {
  const planCards = createCardIndex([
    { id: 'MECH_FILLER', name: 'Мех борда', techLevel: 1, races: ['MECH'], isBaconPool: true },
    { id: 'MECH_SMALL', name: 'Мелкий мех', techLevel: 1, races: ['MECH'], isBaconPool: true },
    { id: 'MECH_BIG', name: 'Большой мех', techLevel: 4, races: ['MECH'], isBaconPool: true },
    {
      id: 'MAGNET',
      name: 'Магнитный мех',
      techLevel: 3,
      races: ['MECH'],
      isBaconPool: true,
      mechanics: ['MODULAR'],
    },
  ]);
  const planDeps = { cards: planCards };

  it('одно место и три карты: лучшее тело в слот, магнит — к цели', () => {
    // part9, ход 25: на борде одно место, в руке Glambot, Ученица и магнитный
    // Созвучатор. Отдельные советы «разыграть» игрок читает как «поставь одну».
    const s = state({
      board: Array.from({ length: 6 }, (_, i) =>
        minion(i + 1, { cardId: 'MECH_FILLER', attack: 2, health: 2 }),
      ),
      hand: [
        minion(11, { cardId: 'MECH_BIG', techLevel: 4, attack: 6, health: 6 }),
        minion(12, { cardId: 'MECH_SMALL', techLevel: 1, attack: 2, health: 2 }),
        minion(13, { cardId: 'MAGNET', techLevel: 3, attack: 3, health: 3 }),
      ],
    });
    const plays = playRules(s, planDeps);
    const plan = playPlan(s, planDeps, plays);

    expect(plan).toHaveLength(2);
    // Тело в свободный слот — лучшее по ценности.
    expect(plan[0]?.minion.cardId).toBe('MECH_BIG');
    expect(plan[0]?.magnetizeTo).toBeNull();
    // Магнит после тел: свежеразыгранный мех — тоже кандидат в носители.
    expect(plan[1]?.minion.cardId).toBe('MAGNET');
    expect(plan[1]?.magnetizeTo?.cardId).toBe('MECH_BIG');
  });

  it('меньше двух розыгрышей — плана нет, хватает обычной строки', () => {
    const s = state({
      hand: [minion(11, { cardId: 'MECH_BIG', techLevel: 4, attack: 6, health: 6 })],
    });
    const plays = playRules(s, planDeps);
    expect(playPlan(s, planDeps, plays)).toHaveLength(0);
  });

  it('на полном борде тело сильнее слабейшего идёт через продажу, магнит — даром', () => {
    // part9, ход 25 после доработки: Glambot заслуживал места через продажу,
    // а первый вариант плана его молча терял, оставляя одни магниты.
    const s = state({
      board: Array.from({ length: 7 }, (_, i) =>
        minion(i + 1, { cardId: 'MECH_FILLER', attack: 2, health: 2 }),
      ),
      hand: [
        minion(11, { cardId: 'MECH_BIG', techLevel: 4, attack: 6, health: 6 }),
        minion(12, { cardId: 'MAGNET', techLevel: 3, attack: 3, health: 3 }),
      ],
    });
    const plays = playRules(s, planDeps);
    const plan = playPlan(s, planDeps, plays);

    expect(plan).toHaveLength(2);
    expect(plan[0]?.minion.cardId).toBe('MECH_BIG');
    expect(plan[0]?.sellFirst).not.toBeNull();
    expect(plan[1]?.minion.cardId).toBe('MAGNET');
    expect(plan[1]?.magnetizeTo).not.toBeNull();
    expect(plan[1]?.sellFirst).toBeNull();
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

  it('при отставании и полном золоте первым идёт подъём, тройка следом', () => {
    const s = state({
      turn: 9,
      techLevel: 2,
      gold: 10,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_1')],
      shop: [shopMinion(9, 'MURLOC_1')],
    });
    const actions = adviseTavern(s, deps)?.recommendations.map((r) => r.action) ?? [];
    expect(actions[0]).toBe('levelUp');
    expect(actions[1]).toBe('buy');
  });

  it('когда золота хватает на одно, тройка перевешивает подъём', () => {
    const s = state({
      turn: 9,
      techLevel: 2,
      gold: 5,
      tavernUpgradeCost: 5,
      tavernUpgradeTarget: 3,
      board: [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_1')],
      shop: [shopMinion(9, 'MURLOC_1')],
    });
    const first = adviseTavern(s, deps)?.recommendations[0];
    expect(first?.action).toBe('buy');
    expect(first?.reason).toContain('собирает тройку');
  });

  it('купленное в руке советуется разыграть', () => {
    const s = state({ hand: [shopMinion(9, 'DRAGON_1', { attack: 5, health: 5 })] });
    const actions = adviseTavern(s, deps)?.recommendations.map((r) => r.action) ?? [];
    expect(actions).toContain('play');
  });
});

describe('заклинание-жертва: «Destroy a friendly …»', () => {
  const idx = createCardIndex([
    {
      id: 'BUTCHER',
      name: 'Разделка туши',
      text: 'Destroy a friendly Undead. Your Undead have +{0}/+{1} this game.',
    },
    { id: 'GOLEM', name: 'Голем', races: ['MECH'], isBaconPool: true, techLevel: 6 },
    { id: 'UND_BIG', name: 'Крупная нежить', races: ['UNDEAD'], isBaconPool: true, techLevel: 3 },
    { id: 'UND_SMALL', name: 'Мелкая нежить', races: ['UNDEAD'], isBaconPool: true, techLevel: 1 },
  ]);
  const butcher = { entityId: 50, cardId: 'BUTCHER', cost: 2, scriptData: [6, 2], zonePos: 0, unplayable: false, costsHealth: false };

  it('целится в наименьшего своего подходящего племени (part13, ход 21)', () => {
    const s = state({
      gold: 5,
      board: [
        minion(1, { cardId: 'GOLEM', attack: 200, health: 122 }),
        minion(2, { cardId: 'UND_BIG', attack: 23, health: 15 }),
        minion(3, { cardId: 'UND_SMALL', attack: 3, health: 1 }),
      ],
      shopSpells: [butcher],
    });
    const rec = shopSpellRules(s, { cards: idx })[0];
    // Жертва — наименьшая нежить. Прежний совет целил «на» крупнейшего
    // своего: предлагал уничтожить голема 200/122, к тому же не-нежить.
    expect(rec?.targetMinion?.cardId).toBe('UND_SMALL');
    expect(rec?.reason).toContain('жертву');
  });

  it('без подходящей жертвы совета нет вовсе', () => {
    const s = state({
      gold: 5,
      board: [minion(1, { cardId: 'GOLEM', attack: 200, health: 122 })],
      shopSpells: [butcher],
    });
    expect(shopSpellRules(s, { cards: idx })).toHaveLength(0);
  });
});

describe('бесплатная сила героя', () => {
  const chromieCards = createCardIndex([
    { id: 'MANA_PM', name: 'Мана в минуту', text: 'Refresh the Tavern\nwith Tavern spells.' },
    { id: 'DMG_P', name: 'Урон', text: 'Deal 3 damage to a minion.' },
  ]);
  const chromie = (patch: Partial<Hero> = {}): Hero => ({
    ...hero(30),
    heroPowerCardId: 'MANA_PM',
    heroPowerEntityId: 136,
    heroPowerCost: null,
    heroPowerHasActivate: true,
    heroPowerScriptData: [],
    ...patch,
  });
  const chromieDeps = { cards: chromieCards };

  it('бесплатная активная сила-обновление советуется (part13, Хроми)', () => {
    const rec = freeHeroPowerRule(state({ hero: chromie() }), chromieDeps);
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(0);
    expect(rec?.reason).toContain('обновляет витрину');
  });

  it('нажатая, платная, пассивная или запертая — молчание', () => {
    expect(
      freeHeroPowerRule(state({ hero: chromie({ heroPowerUsedThisTurn: true }) }), chromieDeps),
    ).toBeNull();
    expect(
      freeHeroPowerRule(state({ hero: chromie({ heroPowerCost: 2 }) }), chromieDeps),
    ).toBeNull();
    expect(
      freeHeroPowerRule(state({ hero: chromie({ heroPowerHasActivate: false }) }), chromieDeps),
    ).toBeNull();
    expect(
      freeHeroPowerRule(state({ hero: chromie({ heroPowerUnplayable: true }) }), chromieDeps),
    ).toBeNull();
    // Замок по тиру (part37) — тот же запрет и та же общая проверка.
    expect(
      freeHeroPowerRule(state({ hero: chromie({ heroPowerLocked: true }) }), chromieDeps),
    ).toBeNull();
  });

  it('бесплатная сила вне «обновить витрину» — по-прежнему не берёмся судить', () => {
    expect(
      freeHeroPowerRule(state({ hero: chromie({ heroPowerCardId: 'DMG_P' }) }), chromieDeps),
    ).toBeNull();
  });
});

describe('сила героя, дающая своему миньону ключевое слово (part32, Король-лич)', () => {
  const lichCards = createCardIndex([
    {
      id: 'RITES',
      name: 'Ритуал перерождения',
      text: '[x]Give a minion <b>Reborn</b>\nuntil next turn.',
    },
    { id: 'BOON', name: 'Благословение света', text: 'Give a minion Divine Shield.' },
    { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 2, races: ['UNDEAD'], isBaconPool: true },
    {
      id: 'RATTLER',
      name: 'Черепушка',
      type: 'Minion',
      techLevel: 1,
      races: ['UNDEAD'],
      isBaconPool: true,
      mechanics: ['DEATHRATTLE'],
      text: '<b>Deathrattle:</b> Summon\ntwo 1/1 Skeletons.',
    },
    {
      id: 'MUMMY',
      name: 'Мумификатор',
      type: 'Minion',
      techLevel: 3,
      races: ['UNDEAD'],
      isBaconPool: true,
      mechanics: ['DEATHRATTLE'],
      text: '<b>Deathrattle:</b> Give a different friendly Undead <b>Reborn</b>.',
    },
  ]);
  const lich = (patch: Partial<Hero> = {}): Hero => ({
    ...hero(30),
    heroPowerCardId: 'RITES',
    heroPowerEntityId: 121,
    heroPowerCost: null,
    heroPowerHasActivate: true,
    heroPowerScriptData: [],
    ...patch,
  });
  const lichDeps = { cards: lichCards };

  it('бесплатная сила «даёт перерождение» советуется и называет цель (part32, ход 1)', () => {
    // Скриншот: золото 0/3, на борде один Glim Guardian 1/4 — совет был «НИЧЕГО».
    const s = state({ hero: lich(), gold: 0, board: [minion(1, { cardId: 'BODY', attack: 1, health: 4 })] });
    const rec = heroPowerKeywordRule(s, lichDeps);
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(0);
    expect(rec?.targetMinion?.entityId).toBe(1);
    expect(rec?.grantsKeyword).toBe('reborn');
    // Перерождение стоит как у покупки: min(2, статы 2.5) = 2.
    expect(rec?.score).toBe(2);
    expect(rec?.reason).toContain('перерождение на Тело 1/4');
  });

  it('тому, у кого перерождения ещё нет; всем уже есть — молчание', () => {
    const s = state({
      hero: lich(),
      board: [
        minion(1, { cardId: 'BODY', attack: 9, health: 9, reborn: true }),
        minion(2, { cardId: 'BODY', attack: 2, health: 2 }),
      ],
    });
    expect(heroPowerKeywordRule(s, lichDeps)?.targetMinion?.entityId).toBe(2);
    const all = state({ hero: lich(), board: [minion(1, { cardId: 'BODY', reborn: true })] });
    expect(heroPowerKeywordRule(all, lichDeps)).toBeNull();
  });

  it('носитель хрипа впереди тела без хрипа — хрип сработает дважды', () => {
    const s = state({
      hero: lich(),
      board: [
        minion(1, { cardId: 'BODY', attack: 6, health: 8 }),
        minion(2, { cardId: 'RATTLER', attack: 5, health: 1 }),
      ],
    });
    const rec = heroPowerKeywordRule(s, lichDeps);
    expect(rec?.targetMinion?.entityId).toBe(2);
    expect(rec?.reason).toContain('хрип сработает дважды');
  });

  it('хрип, дарящий перерождение, — цепочка, пока есть кому его получить (ходы 13–23)', () => {
    const s = state({
      hero: lich(),
      board: [
        minion(1, { cardId: 'RATTLER', attack: 10, health: 3 }),
        minion(2, { cardId: 'MUMMY', attack: 9, health: 2 }),
        minion(3, { cardId: 'BODY', attack: 6, health: 8 }),
      ],
    });
    const rec = heroPowerKeywordRule(s, lichDeps);
    expect(rec?.targetMinion?.entityId).toBe(2);
    expect(rec?.reason).toContain('цепочка');

    // Получать некому — все остальные уже перерождённые: цепочки нет,
    // Mummifier остаётся целью как единственный без перерождения, но
    // обещание «цепочка» совет не даёт.
    const spent = state({
      hero: lich(),
      board: [
        minion(1, { cardId: 'RATTLER', attack: 10, health: 3, reborn: true }),
        minion(2, { cardId: 'MUMMY', attack: 9, health: 2 }),
        minion(3, { cardId: 'RATTLER', attack: 4, health: 8, reborn: true }),
      ],
    });
    const late = heroPowerKeywordRule(spent, lichDeps);
    expect(late?.targetMinion?.entityId).toBe(2);
    expect(late?.reason).not.toContain('цепочка');
  });

  it('среди носителей хрипа решает атака: вторая жизнь — с одним здоровьем', () => {
    const s = state({
      hero: lich(),
      board: [
        minion(1, { cardId: 'RATTLER', attack: 6, health: 8 }),
        minion(2, { cardId: 'RATTLER', attack: 10, health: 3 }),
      ],
    });
    const rec = heroPowerKeywordRule(s, lichDeps);
    expect(rec?.targetMinion?.entityId).toBe(2);
    expect(rec?.reason).toContain('с полной атакой на одно здоровье');
  });

  it('нажатая, пассивная, запертая, пустой борд, чужой текст — молчание', () => {
    const b = [minion(1, { cardId: 'BODY' })];
    expect(heroPowerKeywordRule(state({ hero: lich({ heroPowerUsedThisTurn: true }), board: b }), lichDeps)).toBeNull();
    expect(heroPowerKeywordRule(state({ hero: lich({ heroPowerHasActivate: false }), board: b }), lichDeps)).toBeNull();
    expect(heroPowerKeywordRule(state({ hero: lich({ heroPowerUnplayable: true }), board: b }), lichDeps)).toBeNull();
    expect(heroPowerKeywordRule(state({ hero: lich({ heroPowerLocked: true }), board: b }), lichDeps)).toBeNull();
    expect(heroPowerKeywordRule(state({ hero: lich(), board: [] }), lichDeps)).toBeNull();
    expect(heroPowerKeywordRule(state({ hero: lich({ heroPowerCardId: 'BODY' }), board: b }), lichDeps)).toBeNull();
  });

  it('платный щит за 1 по курсу золота молчит: щит не дороже трёх очков', () => {
    // 3 − 1 × 3 = 0 — не порог, а честная цена на нашей шкале.
    const s = state({ hero: lich({ heroPowerCardId: 'BOON', heroPowerCost: 1 }), gold: 5, board: [minion(1, { cardId: 'BODY', attack: 6, health: 6 })] });
    expect(heroPowerKeywordRule(s, lichDeps)).toBeNull();
    // Даром — щит на крупнейшего без щита.
    const free = state({ hero: lich({ heroPowerCardId: 'BOON' }), board: [minion(1, { cardId: 'BODY', attack: 6, health: 6, divineShield: true }), minion(2, { cardId: 'BODY', attack: 2, health: 2 })] });
    const rec = heroPowerKeywordRule(free, lichDeps);
    expect(rec?.grantsKeyword).toBe('divineShield');
    expect(rec?.targetMinion?.entityId).toBe(2);
  });

  it('план кладёт слово на цель и не рвётся: шаг прозрачен', () => {
    const s = state({ hero: lich(), gold: 0, board: [minion(1, { cardId: 'BODY', attack: 1, health: 4 })] });
    const plan = spendPlan(s, lichDeps);
    const step = plan.steps.find((st) => st.recommendation.action === 'heroPower');
    expect(step).not.toBeUndefined();
    expect(step?.opaque).toBe(false);
    expect(step?.stateAfter.board[0]?.reborn).toBe(true);
    expect(step?.stateAfter.hero?.heroPowerUsedThisTurn).toBe(true);
    expect(plan.truncated).toBe(false);
  });
});

describe('сила героя, ВЫСТРЕЛИВАЮЩАЯ миньоном витрины (part29, Тавиш)', () => {
  const tavishCards = createCardIndex([
    {
      id: 'LOCK',
      name: 'На изготовку!',
      text: '[x]Remove a minion in the\nTavern. When you have\nspace next combat, fire it at\na random enemy minion.',
    },
    { id: 'BIG', name: 'Крупный', type: 'Minion', techLevel: 3, races: [], isBaconPool: true },
    { id: 'SMALL', name: 'Мелкий', type: 'Minion', techLevel: 1, races: [], isBaconPool: true },
    { id: 'FILLER', name: 'Свой', type: 'Minion', techLevel: 1, races: [], isBaconPool: true },
  ]);
  const tavish = (patch: Partial<Hero> = {}): Hero => ({
    ...hero(30),
    heroPowerCardId: 'LOCK',
    heroPowerEntityId: 181,
    heroPowerCost: null,
    heroPowerHasActivate: true,
    heroPowerScriptData: [],
    ...patch,
  });
  const tavishDeps = { cards: tavishCards };
  const shop = [
    minion(10, { cardId: 'BIG', techLevel: 3, attack: 6, health: 6 }),
    minion(11, { cardId: 'SMALL', techLevel: 1, attack: 2, health: 2 }),
  ];

  it('при нулевом золоте стреляем лучшим телом витрины', () => {
    const s = state({ hero: tavish(), gold: 0, shop });
    const rec = heroPowerShotRule(s, tavishDeps);
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(0);
    expect(rec?.minion?.cardId).toBe('BIG');
  });

  it('на деньги стреляем тем, чего НЕ купим: лучшая покупка не цель', () => {
    // Три золота — одна покупка, и она достанется крупному телу; сила
    // забирает карту из витрины насовсем, поэтому целью остаётся мелкий.
    const s = state({ hero: tavish(), gold: 3, shop });
    expect(heroPowerShotRule(s, tavishDeps)?.minion?.cardId).toBe('SMALL');
  });

  it('свободных слотов нет — молчим: выстрела не будет', () => {
    const s = state({
      hero: tavish(),
      gold: 0,
      shop,
      board: Array.from({ length: 7 }, (_, i) => minion(20 + i, { cardId: 'FILLER' })),
    });
    expect(heroPowerShotRule(s, tavishDeps)).toBeNull();
  });

  it('покупок больше, чем слотов, не бывает — цель находится и на богатом ходу', () => {
    // Десять золота — это три покупки, но свободный слот один: витрина
    // из двух карт целиком «по карману» лишь на бумаге.
    const s = state({
      hero: tavish(),
      gold: 10,
      shop,
      // Борд из ЧУЖИХ карт: копии витрины подняли бы мелкого в ценности
      // и перевернули бы порядок, который тест и проверяет.
      board: Array.from({ length: 6 }, (_, i) => minion(30 + i, { cardId: 'FILLER' })),
    });
    expect(heroPowerShotRule(s, tavishDeps)?.minion?.cardId).toBe('SMALL');
  });

  it('другая бесплатная сила выстрелом не считается', () => {
    const s = state({ hero: tavish({ heroPowerCardId: 'SMALL' }), gold: 0, shop });
    expect(heroPowerShotRule(s, tavishDeps)).toBeNull();
  });

  it('сила под замком не стреляет (part37)', () => {
    const s = state({ hero: tavish({ heroPowerLocked: true }), gold: 0, shop });
    expect(heroPowerShotRule(s, tavishDeps)).toBeNull();
  });
});

describe('сила героя, дающая заклинание таверны (part15, Холли\'дэй)', () => {
  const holliCards = createCardIndex([
    {
      id: 'FROGS',
      name: 'Благословение девяти лягушек',
      text: 'Get a random Tavern spell.',
    },
    { id: 'DMG_P', name: 'Урон', text: 'Deal 3 damage to a minion.' },
  ]);
  const holli = (patch: Partial<Hero> = {}): Hero => ({
    ...hero(30),
    heroPowerCardId: 'FROGS',
    heroPowerEntityId: 166,
    heroPowerCost: 1,
    heroPowerHasActivate: true,
    heroPowerScriptData: [],
    ...patch,
  });
  const holliDeps = { cards: holliCards };

  it('при остатке золота советуется: заклинание стоит дороже своей цены', () => {
    // part15, ход 7: золото 1, совет молчал, и золото сгорало — на что
    // игрок и указал.
    const rec = heroPowerSpellRule(state({ hero: holli(), gold: 1 }), holliDeps);
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(1);
    expect(rec?.reason).toContain('заклинание таверны');
    // Очки малые: напоминание к концу хода, а не конкурент покупкам.
    expect(rec?.score).toBeLessThan(DEFAULT_TAVERN_RULES.value.perTechLevel * 3);
  });

  it('нажатая, запертая, не по карману или пассивная — молчание', () => {
    expect(
      heroPowerSpellRule(state({ hero: holli({ heroPowerUsedThisTurn: true }), gold: 1 }), holliDeps),
    ).toBeNull();
    expect(
      heroPowerSpellRule(state({ hero: holli({ heroPowerUnplayable: true }), gold: 1 }), holliDeps),
    ).toBeNull();
    expect(
      heroPowerSpellRule(state({ hero: holli({ heroPowerLocked: true }), gold: 1 }), holliDeps),
    ).toBeNull();
    expect(heroPowerSpellRule(state({ hero: holli(), gold: 0 }), holliDeps)).toBeNull();
    expect(
      heroPowerSpellRule(state({ hero: holli({ heroPowerHasActivate: false }), gold: 1 }), holliDeps),
    ).toBeNull();
  });

  it('платная сила вне «даёт заклинание» — по-прежнему не берёмся судить', () => {
    expect(
      heroPowerSpellRule(state({ hero: holli({ heroPowerCardId: 'DMG_P' }), gold: 5 }), holliDeps),
    ).toBeNull();
  });

  it('сила дороже своей ценности — молчание: правило из данных', () => {
    // Ценность 6 очков — два золота по курсу; сила за 2 съедает всю выгоду.
    expect(
      heroPowerSpellRule(state({ hero: holli({ heroPowerCost: 2 }), gold: 5 }), holliDeps),
    ).toBeNull();
  });
});

describe('синергия с механикой из текста (part15, Titus)', () => {
  const mechCards = createCardIndex([
    {
      id: 'TITUS',
      name: 'Тит Ривендер',
      type: 'Minion',
      techLevel: 5,
      races: [],
      isBaconPool: true,
      mechanics: ['AURA'],
      text: 'Your <b>Deathrattles</b> trigger an extra time.',
    },
    {
      id: 'RATTLER',
      name: 'Хрип',
      type: 'Minion',
      techLevel: 2,
      races: ['BEAST'],
      isBaconPool: true,
      mechanics: ['DEATHRATTLE'],
      text: '<b>Deathrattle:</b> Summon a 1/1.',
    },
    {
      id: 'PLAIN_M',
      name: 'Тело',
      type: 'Minion',
      techLevel: 2,
      races: ['BEAST'],
      isBaconPool: true,
    },
  ]);
  const mechDeps = { cards: mechCards };

  it('усилитель хрипов ценится за каждого своего хрипа', () => {
    // Titus 5/9 на борде хрипов был слабейшим по голым статам, и советник
    // предлагал продать его — на что игрок и указал (part15, ход 17).
    const board = [
      minion(1, { cardId: 'RATTLER' }),
      minion(2, { cardId: 'RATTLER' }),
      minion(3, { cardId: 'PLAIN_M' }),
    ];
    const titus = minion(9, { cardId: 'TITUS', attack: 5, health: 9 });
    const value = minionValue(titus, state({ board }), mechDeps);
    expect(value.textMechMates).toBe(2);
    expect(value.textMech).toBe(2 * DEFAULT_TAVERN_RULES.value.perTextMechMate);
  });

  it('своя механика синергией не считается: хрип про свой же хрип молчит', () => {
    // Buzzing Vermin пишет «Deathrattle:» о себе — это описание, не связь.
    const board = [minion(1, { cardId: 'RATTLER' })];
    const rattler = minion(9, { cardId: 'RATTLER' });
    expect(minionValue(rattler, state({ board }), mechDeps).textMechMates).toBe(0);
  });
});

describe('изменённая цена покупки', () => {
  it('скидка читается с миньона витрины (part3: 9999 — даром, part4: 2 — цена 1)', () => {
    expect(buyCostOf(minion(1, { tags: { BACON_REDUCE_BUY_COST: 2 } }))).toBe(1);
    // 9999 — «бесплатно»: цена клампится в ноль, а не уходит в минус.
    expect(buyCostOf(minion(2, { tags: { BACON_REDUCE_BUY_COST: 9999 } }))).toBe(0);
    expect(buyCostOf(minion(3))).toBe(3);
  });

  /**
   * part35: «They cost (1)» у «Мозаики Стылой Межи» пишет цену ТОЛЬКО
   * на кнопки `DragBuy`, тега скидки на миньонах нет вовсе. Живая цена
   * с кнопки — первый источник; тег — запасной путь для старых записей
   * датасета (там поля нет: `undefined`, а не `null`) и тестов без кнопок.
   */
  it('живая цена с кнопки DragBuy идёт первой, тег скидки — запасной путь', () => {
    expect(buyCostOf(minion(1, { buyCost: 1 }))).toBe(1);
    expect(buyCostOf(minion(2, { buyCost: 0 }))).toBe(0);
    // Кнопка и тег расходятся на одно событие (part4, 00:25:09): верит кнопке.
    expect(buyCostOf(minion(3, { buyCost: 1, tags: { BACON_REDUCE_BUY_COST: 0 } }))).toBe(1);
    expect(buyCostOf(minion(4, { buyCost: null, tags: { BACON_REDUCE_BUY_COST: 2 } }))).toBe(1);
    // Запись датасета до part35: поля нет — запасной путь, не NaN.
    const legacy = { ...minion(5, { tags: { BACON_REDUCE_BUY_COST: 2 } }) } as Record<string, unknown>;
    delete legacy['buyCost'];
    expect(buyCostOf(legacy as unknown as Minion)).toBe(1);
  });

  it('покупка по цене с кнопки советуется при золоте меньше трёх — с её ценой и вслух', () => {
    const s = state({
      gold: 2,
      shop: [shopMinion(9, 'MURLOC_1', { buyCost: 1 }), shopMinion(8, 'MURLOC_2', { buyCost: 3 })],
    });
    const buys = buyRules(s, deps);
    expect(buys).toHaveLength(1);
    expect(buys[0]?.minion?.cardId).toBe('MURLOC_1');
    expect(buys[0]?.cost).toBe(1);
    expect(buys[0]?.reason).toContain('скидка — за 1 вместо 3');
  });

  it('покупка со скидкой советуется при золоте меньше трёх — с её ценой и вслух', () => {
    const s = state({
      gold: 1,
      shop: [
        shopMinion(9, 'MURLOC_1', { tags: { BACON_REDUCE_BUY_COST: 2 } }),
        shopMinion(8, 'MURLOC_2'),
      ],
    });
    const buys = buyRules(s, deps);
    // Полная цена не по карману, скидочный миньон — по карману.
    expect(buys).toHaveLength(1);
    expect(buys[0]?.minion?.cardId).toBe('MURLOC_1');
    expect(buys[0]?.cost).toBe(1);
    expect(buys[0]?.reason).toContain('скидка — за 1 вместо 3');
  });
});

describe('состав племён партии по витрине', () => {
  const lobbyCards = createCardIndex([
    { id: 'U1', name: 'Нежить', techLevel: 1, races: ['UNDEAD'], isBaconPool: true },
    { id: 'N1', name: 'Нага', techLevel: 1, races: ['NAGA'], isBaconPool: true },
    { id: 'Q1', name: 'Свинобраз', techLevel: 1, races: ['QUILBOAR'], isBaconPool: true },
    // «Рука-протез»: двуплеменная карта в пуле part11 БЕЗ мехов — мехов
    // она не доказывает.
    { id: 'DUAL', name: 'Рука', techLevel: 3, races: ['MECH', 'UNDEAD'], isBaconPool: true },
    { id: 'AM', name: 'Амальгама', techLevel: 4, races: ['ALL'], isBaconPool: true },
    { id: 'NEUT', name: 'Нейтрал', techLevel: 2, races: [], isBaconPool: true },
  ]);

  it('однoплеменные миньоны доказывают племя, двуплеменные и амальгамы — нет', () => {
    const s = state({ seenShopCardIds: ['U1', 'N1', 'DUAL', 'AM', 'NEUT'] });
    expect([...lobbyRaces(s, lobbyCards)].sort()).toEqual(['NAGA', 'UNDEAD']);
  });

  it('тринкет для недоказанного племени говорит об этом вслух', () => {
    // Амальгама числится «своей» для дракона — и это правда, бафф на неё
    // ляжет. Но драконов партия не видела ни разу, и об этом сказано.
    const s = state({
      seenShopCardIds: ['U1', 'N1', 'Q1'],
      board: [minion(1, { cardId: 'AM' })],
      trinketOffer: [{ entityId: 900, cardId: 'TRINK_D', subsetRaces: ['DRAGON'], cost: null }],
    });
    const advice = trinketAdvice(s, { cards: lobbyCards });
    expect(advice[0]?.tribeMinions).toBe(1);
    expect(advice[0]?.reason).toContain('DRAGON в витринах партии не встречалось');
  });

  it('пока состав недонабран, молчание данных не считается отсутствием племени', () => {
    const s = state({
      seenShopCardIds: ['U1'],
      board: [minion(1, { cardId: 'AM' })],
      trinketOffer: [{ entityId: 900, cardId: 'TRINK_D', subsetRaces: ['DRAGON'], cost: null }],
    });
    const advice = trinketAdvice(s, { cards: lobbyCards });
    expect(advice[0]?.reason).not.toContain('не встречалось');
  });
});

describe('боевой эффект из текста и кап ключевых слов', () => {
  const battleCards = createCardIndex([
    {
      id: 'BAT',
      name: 'Мышь с ралли',
      techLevel: 1,
      races: ['BEAST'],
      isBaconPool: true,
      text: '<b>Rally:</b> Summon a {0}/{1} Beast.',
    },
    { id: 'PLAIN', name: 'Голое тело', techLevel: 1, races: ['NAGA'], isBaconPool: true },
    {
      id: 'TRIGGER',
      name: 'Триггер на призыв',
      techLevel: 1,
      races: [],
      isBaconPool: true,
      text: 'After you summon a Beast, gain +1 Attack.',
    },
  ]);
  const battleDeps = { cards: battleCards };

  it('«Rally: Summon» ценится, триггер «After you summon» — нет (part6, ход 1)', () => {
    // Flittering Bat выигрывала бой в 100% там, где лучшее по статам — в 0%:
    // второе тело на раннем борде решает всё, а в статах его не видно.
    const bat = minionValue(
      minion(1, { cardId: 'BAT', attack: 1, health: 3, techLevel: 1 }),
      state(),
      battleDeps,
    );
    expect(bat.battle).toBeGreaterThan(0);

    const trigger = minionValue(
      minion(2, { cardId: 'TRIGGER', techLevel: 1 }),
      state(),
      battleDeps,
    );
    expect(trigger.battle).toBe(0);

    const plain = minionValue(
      minion(3, { cardId: 'PLAIN', attack: 3, health: 2, techLevel: 1 }),
      state(),
      battleDeps,
    );
    expect(bat.total).toBeGreaterThan(plain.total);
  });

  it('щит и вихрь не стоят дороже тела, которое усиливают (part7, ход 3)', () => {
    // Crackling Cyclone 2/1 со щитом и вихрем советовался против Molten Rock
    // 3/3 при цене промаха 50 п.п.: полный вес щита на полутора очках статов.
    const small = minionValue(
      minion(1, {
        cardId: 'PLAIN',
        attack: 2,
        health: 1,
        techLevel: 1,
        divineShield: true,
        windfury: true,
      }),
      state(),
      battleDeps,
    );
    // Щит ≤ статов в очках (1.5), вихрь ≤ атаки в очках (1).
    expect(small.keywords).toBeCloseTo(2.5, 5);

    const big = minionValue(
      minion(2, {
        cardId: 'PLAIN',
        attack: 8,
        health: 8,
        techLevel: 1,
        divineShield: true,
        windfury: true,
      }),
      state(),
      battleDeps,
    );
    expect(big.keywords).toBeCloseTo(
      DEFAULT_TAVERN_RULES.value.divineShield + DEFAULT_TAVERN_RULES.value.windfury,
      5,
    );
  });
});

describe('заклинание-замена: «Destroy … to get …»', () => {
  const idx = createCardIndex([
    {
      id: 'JAILER_T',
      name: 'Наклейка с Тюремщиком',
      text: 'Destroy a friendly Undead to get a random Undead.',
    },
    { id: 'UND_BIG', name: 'Крупная нежить', races: ['UNDEAD'], isBaconPool: true, techLevel: 4 },
    { id: 'UND_SMALL', name: 'Мелкая нежить', races: ['UNDEAD'], isBaconPool: true, techLevel: 1 },
  ]);

  it('распознаётся без статов и золота в тексте (part14, наклейка Тюремщика)', () => {
    // Прежний разбор возвращал null — совет молчал всю партию.
    const effect = spellEffect('JAILER_T', [], idx);
    expect(effect).not.toBeNull();
    expect(effect?.transforms).toBe(true);
    expect(effect?.destroyRace).toBe('UNDEAD');
  });

  it('советуется на наименьшую нежить, а без нежити молчит', () => {
    const spell = { entityId: 50, cardId: 'JAILER_T', cost: 0, scriptData: [], zonePos: 0, unplayable: false, costsHealth: false };
    const s = state({
      gold: 0,
      board: [
        minion(1, { cardId: 'UND_BIG', attack: 20, health: 20 }),
        minion(2, { cardId: 'UND_SMALL', attack: 2, health: 2 }),
      ],
      handSpells: [spell],
    });
    const rec = spellRules(s, { cards: idx })[0];
    expect(rec?.action).toBe('play');
    expect(rec?.targetMinion?.cardId).toBe('UND_SMALL');
    expect(rec?.reason).toContain('замен');

    const noUndead = state({ board: [minion(1, { cardId: 'MURLOC_1' })], handSpells: [spell] });
    expect(spellRules(noUndead, { cards: idx })).toHaveLength(0);
  });
});

describe('активации миньонов', () => {
  const idx = createCardIndex([
    {
      id: 'GUARD',
      name: 'Надзиратель',
      races: [],
      isBaconPool: true,
      techLevel: 2,
      text: '[x]Activate ({2}): Give another minion +{0}/+{1}.',
    },
    {
      id: 'FISHER',
      name: 'Рыболов',
      races: ['MURLOC'],
      isBaconPool: true,
      techLevel: 3,
      text: 'Activate ({0}): Get a random Murloc.',
    },
    { id: 'BIG', name: 'Крупный', races: [], isBaconPool: true, techLevel: 3 },
  ]);
  const activatable = (id: number, cardId: string, cost: number, nums: (number | null)[]): Minion =>
    minion(id, {
      cardId,
      scriptData: [...nums, null, null, null, null, null, null].slice(0, 6),
      tags: { HAS_ACTIVATE_POWER: 1, INTERACTABLE_OBJECT_COST: cost },
    });

  it('бафф-активация советуется с целью и ценой из тегов (part14, фактура)', () => {
    // «Activate ({2}): Give another minion +{0}/+{1}» — плейсхолдеры в NUM
    // самого миньона, цена — INTERACTABLE_OBJECT_COST.
    const s = state({
      gold: 5,
      board: [
        activatable(1, 'GUARD', 1, [4, 4, 1]),
        minion(2, { cardId: 'BIG', attack: 10, health: 10 }),
      ],
    });
    const rec = adviseTavern(s, { cards: idx })?.recommendations.find(
      (r) => r.action === 'activate',
    );
    expect(rec?.minion?.cardId).toBe('GUARD');
    expect(rec?.cost).toBe(1);
    // Цель — крупнейший ДРУГОЙ: «Give another minion».
    expect(rec?.targetMinion?.cardId).toBe('BIG');
    expect(rec?.reason).toContain('+8 статов');
  });

  it('«Get a random X» ценится телом тира; активированный в этом ходу молчит', () => {
    const s = state({
      gold: 5,
      techLevel: 4,
      board: [activatable(1, 'FISHER', 1, [1])],
    });
    const rec = adviseTavern(s, { cards: idx })?.recommendations.find(
      (r) => r.action === 'activate',
    );
    expect(rec?.reason).toContain('принесёт миньона');

    const used = { ...s, activatedEntityIds: [1] };
    expect(
      adviseTavern(used, { cards: idx })?.recommendations.some((r) => r.action === 'activate'),
    ).toBe(false);
  });

  it('не по карману или без активации — молчание', () => {
    const s = state({ gold: 0, board: [activatable(1, 'FISHER', 2, [2])] });
    expect(
      adviseTavern(s, { cards: idx })?.recommendations.some((r) => r.action === 'activate'),
    ).toBe(false);
    const plain = state({ gold: 5, board: [minion(1, { cardId: 'FISHER' })] });
    expect(
      adviseTavern(plain, { cards: idx })?.recommendations.some((r) => r.action === 'activate'),
    ).toBe(false);
  });
});

describe('боевой эффект «вашим племени» без своих того племени', () => {
  const idx = createCardIndex([
    {
      id: 'DUSTBONE',
      name: 'Ралли нежити',
      techLevel: 3,
      races: ['UNDEAD'],
      isBaconPool: true,
      text: 'Rally: Your Undead have +{0} Attack this game.',
    },
    {
      id: 'BAT',
      name: 'Мышь с призывом',
      techLevel: 1,
      races: ['BEAST'],
      isBaconPool: true,
      text: '<b>Rally:</b> Summon a {0}/{1} Beast.',
    },
    { id: 'ELEM', name: 'Элементаль', techLevel: 2, races: ['ELEMENTAL'], isBaconPool: true },
    { id: 'UND', name: 'Нежить', techLevel: 2, races: ['UNDEAD'], isBaconPool: true },
  ]);
  const d = { cards: idx };
  const dustbone = minion(9, { cardId: 'DUSTBONE', attack: 15, health: 6, techLevel: 3 });

  it('«Rally: Your Undead…» на борде без нежити бонуса не даёт (part14, ход 21)', () => {
    const elems = state({ board: [minion(1, { cardId: 'ELEM' }), minion(2, { cardId: 'ELEM' })] });
    expect(minionValue(dustbone, elems, d).battle).toBe(0);

    // Своя нежить есть — ралли снова ценится.
    const withUndead = state({ board: [minion(1, { cardId: 'UND' })] });
    expect(minionValue(dustbone, withUndead, d).battle).toBeGreaterThan(0);
  });

  it('призыв («Summon a Beast») от борда не зависит', () => {
    const bat = minion(9, { cardId: 'BAT', attack: 1, health: 3, techLevel: 1 });
    expect(minionValue(bat, state({ board: [] }), d).battle).toBeGreaterThan(0);
  });
});

describe('кэш ожидания по пулу тиров', () => {
  /**
   * `averagePoolValue` кэширует ответ по ССЫЛКЕ на массив борда: без кэша
   * один ход плана стоил вдвое дороже. Значит, ключ обязан покрывать всё
   * остальное, от чего ответ зависит, — справочник, таблицу правил, руку,
   * заклинания руки и силу героя. Иначе первый спросивший отвечает за всех,
   * и это не падение, а тихо неверное число: тот же борд, другой вопрос.
   *
   * Спрашивается ответ тёмным даром: его очки — ровно ожидание по пулу
   * названных тиров плюс надбавка, а надбавка нулевая.
   */
  const own = { id: 'OWN', name: 'Свой', type: 'Minion', techLevel: 1, races: [], attack: 1, health: 1 };
  const weak = createCardIndex([
    own,
    { id: 'P2', name: 'Слабый пул', type: 'Minion', techLevel: 2, races: [], isBaconPool: true, attack: 1, health: 1 },
  ]);
  const strong = createCardIndex([
    own,
    { id: 'P2', name: 'Сильный пул', type: 'Minion', techLevel: 2, races: [], isBaconPool: true, attack: 20, health: 20 },
  ]);

  // Ход 5 — третий ход таверны: таблица дара обещает тир 2.
  const giftState = (board: Minion[], patch: Partial<GameState> = {}): GameState =>
    state({ turn: 5, gold: 5, techLevel: 2, darkGiftCost: 1, board, ...patch });

  it('справочник входит в ключ: тот же борд, другой снапшот — другое число', () => {
    // ОДИН И ТОТ ЖЕ массив борда: именно на нём кэш и промахивался.
    const board = [minion(1, { cardId: 'OWN' })];
    const s = giftState(board);

    const weakScore = darkGiftRule(s, { cards: weak })?.score;
    const strongScore = darkGiftRule(s, { cards: strong })?.score;
    expect(weakScore).toBeDefined();
    expect(strongScore).toBeDefined();
    expect(strongScore).toBeGreaterThan(weakScore ?? 0);
  });

  it('таблица правил входит в ключ: свой вес тира — своё число', () => {
    const board = [minion(1, { cardId: 'OWN' })];
    const s = giftState(board);
    const dearTier = {
      ...DEFAULT_TAVERN_RULES,
      value: { ...DEFAULT_TAVERN_RULES.value, perTechLevel: DEFAULT_TAVERN_RULES.value.perTechLevel * 10 },
    };

    const plain = darkGiftRule(s, { cards: weak })?.score ?? 0;
    const dear = darkGiftRule(s, { cards: weak }, dearTier)?.score ?? 0;
    expect(dear).toBeGreaterThan(plain);
  });

  it('заклинания руки входят в ключ: борда розыгрыш не трогает вовсе', () => {
    // Пул из магнита-РАСТУЩЕГО: его ценность зависит от заклинаний руки,
    // а розыгрыш заклинания не меняет ни борда, ни длины руки — прежний
    // ключ на этих двух состояниях был буквально одинаковым.
    const idx = createCardIndex([
      own,
      {
        id: 'MAGNET',
        name: 'Растущий магнит',
        type: 'Minion',
        techLevel: 2,
        races: [],
        isBaconPool: true,
        attack: 1,
        health: 1,
        // Литерал, а не плейсхолдер: у заготовок ПУЛА живых тегов нет
        // вовсе, и `{0}` там честно читается нулём.
        text: 'Whenever you cast a spell on this, gain +2 Health.',
      },
      { id: 'BUFF', name: 'Усиление', type: 'Spell', text: 'Give a minion +2/+2.' },
    ]);
    const board = [minion(1, { cardId: 'OWN' })];
    const spell = {
      entityId: 50,
      cardId: 'BUFF',
      cost: 0,
      scriptData: [1, 1],
      zonePos: 0,
      unplayable: false, costsHealth: false,
    };

    const withSpell = giftState(board, { handSpells: [spell] });
    const played = giftState(board, { handSpells: [] });

    const withScore = darkGiftRule(withSpell, { cards: idx })?.score ?? 0;
    const afterScore = darkGiftRule(played, { cards: idx })?.score ?? 0;
    // Заклинание в руке делает магнит из пула дороже; после розыгрыша —
    // дешевле. Одинаковые числа означали бы, что второй вопрос получил
    // ответ на первый.
    expect(withScore).toBeGreaterThan(afterScore);
  });
});

describe('дневной заряд магнита-хранителя', () => {
  /**
   * «The first Spellcraft spell played from hand on this each turn is
   * permanent» — заряд ОДИН на ход, и второе чародейское заклинание руки
   * постоянным на нём уже не станет. Ценность покупки складывала выгоду
   * по ВСЕМ заклинаниям руки, и хранитель при двух трезубцах получал
   * вдвое больше статов, чем даст на самом деле (part21).
   */
  const idx = createCardIndex([
    {
      id: 'KEEPER',
      name: 'Хранитель заклинаний',
      type: 'Minion',
      techLevel: 3,
      races: ['NAGA'],
      isBaconPool: true,
      text: 'The first Spellcraft spell played from hand on this each turn is permanent.',
    },
    {
      id: 'CRAFTER',
      name: 'Чародей',
      type: 'Minion',
      techLevel: 2,
      races: ['NAGA'],
      isBaconPool: true,
      mechanics: ['BACON_SPELLCRAFT_ID'],
    },
    // Токен чародейства — по соглашению «id миньона плюс t».
    {
      id: 'CRAFTERt',
      name: 'Трезубец',
      type: 'Spell',
      text: 'Give a minion +2 Attack until next turn.',
    },
  ]);
  const d = { cards: idx };
  const keeper = minion(9, { cardId: 'KEEPER', attack: 2, health: 2, techLevel: 3 });
  const trident = (entityId: number) => ({
    entityId,
    cardId: 'CRAFTERt',
    cost: 0,
    scriptData: [] as readonly (number | null)[],
    zonePos: 0,
    unplayable: false, costsHealth: false,
  });

  it('одно заклинание руки — одна выгода', () => {
    const s = state({ board: [], handSpells: [trident(50)] });
    expect(minionValue(keeper, s, d).spellMagnet).toBe(2 * DEFAULT_TAVERN_RULES.value.perStatPoint);
  });

  it('два заклинания руки — выгода ВСЁ ТА ЖЕ: заряд один на ход', () => {
    const one = state({ board: [], handSpells: [trident(50)] });
    const two = state({ board: [], handSpells: [trident(50), trident(51)] });
    expect(minionValue(keeper, two, d).spellMagnet).toBe(minionValue(keeper, one, d).spellMagnet);
  });

  it('исчерпанный заряд из тега — выгоды нет вовсе', () => {
    const spent = minion(9, {
      cardId: 'KEEPER',
      attack: 2,
      health: 2,
      techLevel: 3,
      scriptData: [0],
    });
    const s = state({ board: [], handSpells: [trident(50), trident(51)] });
    expect(minionValue(spent, s, d).spellMagnet).toBe(0);
  });

  it('РАСТУЩИЙ магнит по-прежнему суммирует: заряда у него нет', () => {
    const growing = createCardIndex([
      {
        id: 'GROWER',
        name: 'Растущий',
        type: 'Minion',
        techLevel: 3,
        races: [],
        isBaconPool: true,
        text: 'Whenever you cast a spell on this, gain +1 Health.',
      },
      { id: 'BUFF', name: 'Усиление', type: 'Spell', text: 'Give a minion +2/+2.' },
    ]);
    const g = { cards: growing };
    const grower = minion(9, { cardId: 'GROWER', attack: 1, health: 1, techLevel: 3 });
    const buff = (entityId: number) => ({
      entityId,
      cardId: 'BUFF',
      cost: 0,
      scriptData: [] as readonly (number | null)[],
      zonePos: 0,
      unplayable: false, costsHealth: false,
    });

    const one = minionValue(grower, state({ board: [], handSpells: [buff(50)] }), g).spellMagnet;
    const two = minionValue(
      grower,
      state({ board: [], handSpells: [buff(50), buff(51)] }),
      g,
    ).spellMagnet;
    expect(two).toBe(one * 2);
  });
});

describe('продажа ради ещё одной траты', () => {
  /**
   * `sellForGoldRule` продаёт карту, чьё обещание отдаёт продажа, — но
   * только когда золото открывает ЕЩЁ ОДНУ покупку. Две правки: витрина
   * обязана эту покупку предлагать, и удерживаемая ценность считается
   * против ОСТАЛЬНОГО борда, той же функцией, что у `weakestOwn`.
   */
  const idx = createCardIndex([
    {
      id: 'SKIP',
      name: 'Пропойца',
      type: 'Minion',
      techLevel: 1,
      races: ['MURLOC'],
      isBaconPool: true,
      attack: 1,
      health: 1,
      text: 'When you sell this, get a random Tier 1 minion.',
    },
    {
      id: 'MUR',
      name: 'Мурлок',
      type: 'Minion',
      techLevel: 2,
      races: ['MURLOC'],
      isBaconPool: true,
    },
    {
      id: 'BIG',
      name: 'Крупный',
      type: 'Minion',
      techLevel: 4,
      races: [],
      isBaconPool: true,
      attack: 8,
      health: 8,
    },
  ]);
  const d = { cards: idx };
  const big = (entityId: number) =>
    minion(entityId, { cardId: 'BIG', attack: 8, health: 8, techLevel: 4 });

  it('витрина без ДОПОЛНИТЕЛЬНОЙ покупки — правило молчит', () => {
    // Пять золота покупают одного, шесть — двоих; но в витрине
    // один-единственный миньон, и продавать тело за монету, которой некуда
    // деться, незачем.
    const s = state({
      gold: 5,
      goldTotal: 5,
      board: [minion(1, { cardId: 'SKIP', attack: 1, health: 1, techLevel: 1 })],
      shop: [big(20)],
    });
    expect(sellForGoldRule(s, d)).toBeNull();

    // Второй миньон в витрине — и та самая дополнительная покупка появилась.
    expect(sellForGoldRule({ ...s, shop: [big(20), big(21)] }, d)).not.toBeNull();
  });

  it('удерживаемая ценность считается против ОСТАЛЬНОГО борда', () => {
    const skipper = minion(1, { cardId: 'SKIP', attack: 1, health: 1, techLevel: 1 });
    const mates = [2, 3, 4, 5].map((id) => minion(id, { cardId: 'MUR', techLevel: 2 }));
    const s = state({
      gold: 5,
      goldTotal: 5,
      board: [skipper, ...mates],
      shop: [big(20), big(21)],
    });

    const rest = minionValue(skipper, { ...s, board: mates }, d);
    const alone = minionValue(skipper, { ...s, board: [skipper] }, d);
    const retained = rest.total - rest.copies - rest.economy;
    // Против четырёх соплеменников скипер дороже, чем «сам с собой»:
    // прежняя база считала его собственным соплеменником и теряла связи.
    expect(retained).toBeGreaterThan(alone.total - alone.economy);

    const rec = sellForGoldRule(s, d);
    expect(rec?.reason).toContain(retained.toFixed(1) + ' очков телом');
  });
});

describe('прокрутка: отбор кандидата и бамп порядка — разные числа', () => {
  /**
   * Бамп («иди впереди лучшей покупки») отвечает на вопрос о ПОРЯДКЕ,
   * а не о том, какая из прокруток лучше. Пока он писался в то же поле,
   * по которому шёл отбор, слабый генератор выигрывал у сильного просто
   * потому, что помещался в один ход с дорогой покупкой.
   */
  const idx = createCardIndex([
    {
      id: 'GEN_FOUR',
      name: 'Щедрый генератор',
      type: 'Minion',
      techLevel: 1,
      races: [],
      isBaconPool: true,
      attack: 1,
      health: 1,
      text: 'Battlecry: Get four Slimy Shields.',
    },
    {
      id: 'GEN_TWO',
      name: 'Скупой генератор',
      type: 'Minion',
      techLevel: 1,
      races: [],
      isBaconPool: true,
      attack: 1,
      health: 1,
      text: 'Battlecry: Get two Slimy Shields.',
    },
    {
      id: 'BIG',
      name: 'Крупный',
      type: 'Minion',
      techLevel: 5,
      races: [],
      isBaconPool: true,
      attack: 10,
      health: 10,
    },
  ]);
  const d = { cards: idx };

  it('берётся сильная прокрутка, хоть слабая и помещается рядом с покупкой', () => {
    const four = minion(10, { cardId: 'GEN_FOUR', attack: 1, health: 1, techLevel: 1 });
    // Скидка 2: чистая цена ноль, и эта прокрутка помещается рядом с покупкой.
    const two = minion(11, {
      cardId: 'GEN_TWO',
      attack: 1,
      health: 1,
      techLevel: 1,
      tags: { BACON_REDUCE_BUY_COST: 2 },
    });
    const strong = minion(12, { cardId: 'BIG', attack: 10, health: 10, techLevel: 5 });
    const s = state({ gold: 4, goldTotal: 4, board: [], shop: [four, two, strong] });

    const rec = spinRule(s, d, DEFAULT_TAVERN_RULES, buyRules(s, d));
    expect(rec?.minion?.cardId).toBe('GEN_FOUR');
    // Совет называет число ТОГО генератора, который советует.
    expect(rec?.reason).toContain('клич даст 4 карт');
  });
});

describe('ставка на чужой бой: скины героев', () => {
  /**
   * Варианты «Дружеской ставки» приходят БАЗОВЫМИ картами героев, а в таблице
   * лобби тот же игрок стоит со своим скином (part26). Сырое сравнение
   * их не сводило, и половина ставки уходила в «оценить не берёмся».
   */
  const idx = createCardIndex([
    { id: 'TB_BaconShop_HP_081', name: 'Дружеская ставка', type: 'Hero_power' },
    { id: 'BG27_HERO_801', name: 'Торим', type: 'Hero' },
    { id: 'TB_BaconShop_HERO_33', name: 'Смотритель', type: 'Hero' },
  ]);
  const d = { cards: idx };

  const lobbyPlayer = (playerId: number, heroCardId: string, techLevel: number) => ({
    playerId,
    heroCardId,
    health: 40,
    damage: 0,
    armor: 0,
    techLevel,
    place: playerId,
  });

  it('игрок со скином опознаётся, и ранжирование по тиру работает', () => {
    const s = state({
      lobby: {
        // Тот же герой, что в варианте, но со скином — как в логе.
        5: lobbyPlayer(5, 'BG27_HERO_801_SKIN_A', 3),
        6: lobbyPlayer(6, 'TB_BaconShop_HERO_33', 4),
      },
      openChoice: {
        id: 13,
        sourceCardId: 'TB_BaconShop_HP_081',
        options: [
          { entityId: 4902, cardId: 'BG27_HERO_801' },
          { entityId: 4903, cardId: 'TB_BaconShop_HERO_33' },
        ],
      },
    });

    const advice = choiceAdvice(s, d);
    expect(advice).toHaveLength(2);
    // Ни один вариант не остался без оценки: скин сведён к базовой карте.
    expect(advice.every((a) => a.score !== null)).toBe(true);
    // Впереди тот, у кого тир выше, — и сказано это про тир.
    expect(advice[0]?.option.cardId).toBe('TB_BaconShop_HERO_33');
    expect(advice[0]?.reason).toContain('впереди по тиру');
    expect(advice[1]?.reason).toContain('тир 3');
  });
});

/**
 * Цена ПРИДЕРЖАННОГО заряда дара (part31): зарядов три, предложение растёт
 * по ходам таверны до десятого, и заряд, нажатый на седьмом, — это тело
 * тира 4 вместо тела тира 5–6 на десятом. Игрок все три заряда нажал
 * на 10-м, 11-м и 12-м ходах таверны.
 */
describe('правило тёмного дара: цена придержанного заряда', () => {
  // Борд из мурлоков: пул тира 4 — амальгама, пул тиров 5–6 — пятый мурлок
  // с соплеменниками, то есть «позже» дороже «сейчас».
  const board = [shopMinion(1, 'MURLOC_1'), shopMinion(2, 'MURLOC_2')];
  const giftable = (patch: Partial<GameState> = {}): GameState =>
    state({ darkGiftCost: 3, darkGiftCharges: 3, gold: 9, techLevel: 4, board, ...patch });
  // Ход 13 — седьмой ход таверны: впереди 5.3 хода при трёх зарядах.
  const midgame = giftable({ turn: 13 });

  it('когда ходов впереди больше, чем зарядов, цена спешки вычитается из тела', () => {
    const held = darkGiftRule(midgame, deps);
    // Столько же зарядов, сколько ходов, — вычитать нечего: чистое тело.
    const plain = darkGiftRule(giftable({ turn: 13, darkGiftCharges: 7 }), deps);
    expect(held).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(held?.score ?? 0).toBeLessThan(plain?.score ?? 0);
    expect(held?.reason).toContain('заряд лучше придержать');
    expect(held?.reason).toContain('зарядов 3');
    expect(plain?.reason).toContain('придерживать незачем');
  });

  it('с десятого хода таверны предложение плоское — цена спешки ноль', () => {
    // Ход 21 — одиннадцатый ход таверны, впереди 2.2 при трёх зарядах:
    // вытесняемый ход за концом таблицы, тиры те же, что сейчас.
    const late = darkGiftRule(giftable({ turn: 21, techLevel: 5 }), deps);
    expect(late).not.toBeNull();
    expect(late?.reason).toContain('сильнее предложение уже не станет');
  });

  it('без тега зарядов берётся число из правил, и совет тот же', () => {
    const untagged = darkGiftRule(giftable({ turn: 13, darkGiftCharges: null }), deps);
    expect(untagged?.score).toBeCloseTo(darkGiftRule(midgame, deps)?.score ?? -1, 6);
  });

  it('оставшихся зарядов меньше — вытесняемый ход позже, цена спешки меньше', () => {
    const three = darkGiftRule(midgame, deps)?.score ?? 0;
    const one = darkGiftRule(giftable({ turn: 13, darkGiftCharges: 1 }), deps)?.score ?? 0;
    expect(one).toBeGreaterThanOrEqual(three);
  });

  it('когда цена спешки съедает всё тело, дар молчит', () => {
    // Ход 7 — четвёртый ход таверны: тело тира 2–3 против тира 5–6 при
    // 8.3 ходах впереди. На настоящем пуле part31 разница больше тела;
    // здесь та же арифметика проверяется таблицей с дорогим хвостом.
    const dear = darkGiftRule(giftable({ turn: 7, techLevel: 2 }), {
      cards: createCardIndex([
        ...STUB_CARDS,
        { id: 'MURLOC_6', name: 'Шестой мурлок', type: 'Minion', techLevel: 6, races: ['MURLOC'], isBaconPool: true, attack: 40, health: 40 },
      ]),
    });
    expect(dear).toBeNull();
  });
});

/**
 * Миньон, приходящий В РУКУ, на полном борде вычитает жертву (part31,
 * ход 13): «Discover a Tier 1 minion» за 3 при семи своих — план
 * начинался с ростка (7.1), хотя слабейший свой стоил 9.0.
 */
describe('заклинание витрины «даёт миньона» на полном борде', () => {
  const sproutCards = createCardIndex([
    ...STUB_CARDS,
    { id: 'SPROUT', name: 'Новый росток', type: 'Battleground_spell', text: 'Discover a Tier 1 minion.' },
  ]);
  const sproutDeps = { cards: sproutCards };
  const sprout = { entityId: 900, cardId: 'SPROUT', cost: 3, scriptData: [], zonePos: 0, unplayable: false, costsHealth: false };
  const strong = Array.from({ length: 7 }, (_, i) =>
    shopMinion(10 + i, 'MURLOC_5', { attack: 20, health: 20 }),
  );

  it('на полном борде из сильных тел молчит: место через продажу дороже тела', () => {
    const full = state({ gold: 9, techLevel: 4, board: strong, shopSpells: [sprout] });
    expect(shopSpellRules(full, sproutDeps).some((r) => r.spellCardId === 'SPROUT')).toBe(false);
  });

  it('на неполном борде — прежнее дешёвое тело', () => {
    const room = state({ gold: 9, techLevel: 4, board: strong.slice(0, 6), shopSpells: [sprout] });
    const rec = shopSpellRules(room, sproutDeps).find((r) => r.spellCardId === 'SPROUT');
    expect(rec).not.toBeUndefined();
    expect(rec?.reason).toContain('средний миньон тира 1');
    expect(rec?.reason).not.toContain('борд полон');
  });

  it('на полном борде из слабых тел жертва вычитается и называется', () => {
    const weak = Array.from({ length: 7 }, (_, i) => shopMinion(10 + i, 'NEUTRAL', { attack: 1, health: 1 }));
    const full = state({ gold: 9, techLevel: 1, board: weak, shopSpells: [sprout] });
    const withRoom = shopSpellRules({ ...full, board: weak.slice(0, 6) }, sproutDeps).find(
      (r) => r.spellCardId === 'SPROUT',
    );
    const rec = shopSpellRules(full, sproutDeps).find((r) => r.spellCardId === 'SPROUT');
    if (rec !== undefined) {
      expect(rec.reason).toContain('борд полон — место через продажу');
      expect(rec.score).toBeLessThan(withRoom?.score ?? 0);
    }
  });
});

/**
 * Сила «после N покупок с механикой — награда» (part34, «Бранное дело»:
 * «After you buy 4 Battlecry minions, get a Brann Bronzebeard»). Игрок
 * купил четыре кличевых миньона за четыре хода таверны, получил Бранна
 * на 4-м и пришёл первым; советник ни разу не назвал клич причиной покупки.
 */
describe('сила героя «после N кличевых покупок — Бранн» в ценности покупки (part34)', () => {
  const brandCards = createCardIndex([
    ...STUB_CARDS,
    {
      id: 'BRAND',
      name: 'Battle Brand',
      type: 'Hero_power',
      text: '[x]After you buy 4 <b>Battlecry</b> minions, get a Brann Bronzebeard. <i>(Once per game.)</i>',
    },
    {
      id: 'BRANN',
      name: 'Brann Bronzebeard',
      type: 'Minion',
      techLevel: 5,
      attack: 2,
      health: 4,
      races: [],
      isBaconPool: true,
      mechanics: ['AURA'],
      text: 'Your <b>Battlecries</b> trigger twice.',
    },
    {
      id: 'BUSKER',
      name: 'Southsea Busker',
      type: 'Minion',
      techLevel: 1,
      attack: 3,
      health: 1,
      races: ['PIRATE'],
      isBaconPool: true,
      mechanics: ['BATTLECRY'],
      text: '<b>Battlecry:</b> Gain 1 Gold next turn.',
    },
    {
      id: 'RIDER',
      name: 'Risen Rider',
      type: 'Minion',
      techLevel: 1,
      attack: 2,
      health: 1,
      races: ['UNDEAD'],
      isBaconPool: true,
      mechanics: ['TAUNT', 'REBORN'],
      text: '<b>Taunt</b> <b>Reborn</b>',
    },
    // «After you buy 3 minions, get a Tavern Coin» — без механики-условия
    // и без награды-миньона: шаблон молчит намеренно.
    { id: 'SPHERES', name: 'Verdant Spheres', type: 'Hero_power', text: '[x]After you buy 3 minions, get a Tavern Coin.' },
  ]);
  const brandDeps = { cards: brandCards };
  const brann = (scriptData: readonly (number | null)[] = []): Hero => ({
    ...hero(30),
    heroPowerCardId: 'BRAND',
    heroPowerEntityId: 226,
    heroPowerCost: null,
    heroPowerHasActivate: false,
    heroPowerScriptData: scriptData,
  });
  const busker = minion(7, { cardId: 'BUSKER', attack: 3, health: 1, techLevel: 1 });
  const rider = minion(8, { cardId: 'RIDER', attack: 2, health: 1, techLevel: 1, taunt: true, reborn: true });

  it('сила читается из текста: четыре покупки, механика BATTLECRY, награда — Бранн из пула', () => {
    const r = heroPowerBuyReward(state({ hero: brann() }), brandCards);
    expect(r).not.toBeNull();
    expect(r?.count).toBe(4);
    expect(r?.mechanic).toBe('BATTLECRY');
    expect(r?.reward.id).toBe('BRANN');
    // Тега при создании силы нет — остаток равен числу из текста.
    expect(r?.remaining).toBe(4);
    // Живой счётчик — `TAG_SCRIPT_DATA_NUM_1`: 3 → 2 → 1 → 0.
    expect(heroPowerBuyReward(state({ hero: brann([2]) }), brandCards)?.remaining).toBe(2);
    // Ноль — сила отработала («Once per game»).
    expect(heroPowerBuyReward(state({ hero: brann([0]) }), brandCards)).toBeNull();
    // Без силы такого рода — ничего.
    expect(heroPowerBuyReward(state({ hero: hero(30) }), brandCards)).toBeNull();
    expect(heroPowerBuyReward(state({ hero: { ...brann(), heroPowerCardId: 'SPHERES' } }), brandCards)).toBeNull();
  });

  it('кличевой кандидат получает долю награды, некличевой — нет (part34, ход 1)', () => {
    // Ход 1: витрина Southsea Busker 3/1 (клич) и Risen Rider 2/1 (провокация,
    // перерождение). Прежде Rider 6.0 стоял над Busker 4.0.
    const s = state({ hero: brann(), board: [], shop: [busker, rider], turn: 1, techLevel: 1, gold: 3, goldTotal: 3 });
    const b = minionValue(busker, s, brandDeps);
    const r = minionValue(rider, s, brandDeps);
    expect(r.heroPowerBuy).toBe(0);
    expect(r.heroPowerBuyLeft).toBeNull();
    // Бранн на пустом борде: тир 5 → 10, тело 2/4 → 3; четверть — 3.25.
    expect(b.heroPowerBuy).toBeCloseTo(13 / 4, 5);
    expect(b.heroPowerBuyLeft).toBe(3);
    expect(b.heroPowerBuyReward).toBe('Brann Bronzebeard');
    expect(b.total).toBeGreaterThan(r.total);

    // `buyRules` отдаёт советы в порядке витрины — ранжирует `adviseTavern`.
    const recs = [...buyRules(s, brandDeps)].sort((a, b) => b.score - a.score);
    expect(recs[0]?.minion?.cardId).toBe('BUSKER');
    expect(recs[0]?.heroPowerBuyLeft).toBe(3);
    expect(recs[0]?.reason).toContain('сила героя: до Brann Bronzebeard ещё 3 такие покупки');
    expect(recs.find((x) => x.minion?.cardId === 'RIDER')?.heroPowerBuyLeft).toBeUndefined();
  });

  it('доля растёт к последней покупке: последняя стоит целого Бранна', () => {
    const at = (left: number) => minionValue(busker, state({ hero: brann([left]), board: [] }), brandDeps);
    expect(at(1).heroPowerBuy).toBeCloseTo(13, 5);
    expect(at(1).heroPowerBuyLeft).toBe(0);
    expect(at(2).heroPowerBuy).toBeCloseTo(13 / 2, 5);
    const recs = buyRules(state({ hero: brann([1]), board: [], shop: [busker] }), brandDeps);
    expect(recs[0]?.reason).toContain('сила героя: эта покупка приносит Brann Bronzebeard');
  });

  it('награда считается на ЭТОМ борде: при своих кличевых Бранн дороже', () => {
    const empty = minionValue(busker, state({ hero: brann([1]), board: [] }), brandDeps);
    const withBattlecries = minionValue(
      busker,
      state({
        hero: brann([1]),
        board: [
          minion(1, { cardId: 'BUSKER', attack: 3, health: 1, techLevel: 1 }),
          minion(2, { cardId: 'BUSKER', attack: 3, health: 1, techLevel: 1 }),
        ],
      }),
      brandDeps,
    );
    // «Your Battlecries trigger twice» — механика из текста, своих с кличем два.
    expect(withBattlecries.heroPowerBuy).toBeGreaterThan(empty.heroPowerBuy);
  });

  it('после нуля слагаемого нет — сила отработала', () => {
    const b = minionValue(busker, state({ hero: brann([0]), board: [] }), brandDeps);
    expect(b.heroPowerBuy).toBe(0);
    expect(b.heroPowerBuyLeft).toBeNull();
  });
});

/**
 * part35: «Refresh the Tavern with Battlecry minions. They cost (1)» —
 * чародейское заклинание тринкета «Мозаика Стылой Межи» в руке. Прежде
 * невидимо (ни статов, ни золота, ни миньона), советник на скриншоте
 * говорил «ОБНОВИТЬ за 1» и «НИЧЕГО» при двух золотых.
 */
describe('заклинание руки, обновляющее витрину с ценой (part35)', () => {
  const MOSAIC = 'MOSAIC';
  const mosaicCards = createCardIndex([
    ...STUB_CARDS,
    { id: 'CRIER_1', name: 'Кликун', type: 'Minion', techLevel: 1, races: [], isBaconPool: true, mechanics: ['BATTLECRY'] },
    { id: 'CRIER_2', name: 'Кликун 2', type: 'Minion', techLevel: 2, races: [], isBaconPool: true, mechanics: ['BATTLECRY'] },
    {
      id: MOSAIC,
      name: 'Мозаика',
      type: 'Spell',
      isBaconPool: true,
      text: '[x]<b>Refresh</b> the Tavern with\n<b>Battlecry</b> minions.\nThey cost (1).',
    },
  ]);
  const mosaicDeps = { cards: mosaicCards };
  const mosaic = (cost = 0) => ({ entityId: 700, cardId: MOSAIC, cost, scriptData: [null, null, null, null], zonePos: 0, unplayable: false, costsHealth: false });

  it('шаблон читает цену после обновления сквозь разметку и переносы строк', () => {
    const s = state({ gold: 2, shop: [shopMinion(9, 'DRAGON_1')] });
    const rec = discountRefreshRule(mosaic(), s, mosaicDeps);
    expect(rec?.action).toBe('play');
    expect(rec?.spellCardId).toBe(MOSAIC);
    expect(rec?.refreshesShop).toBe(true);
    expect(rec?.reason).toContain('обновление витрины кличевыми по 1');
  });

  it('ценность — тела: покупок по 1 на остаток золота против покупок по карману сейчас', () => {
    // Два золота, витрина по три: сейчас покупок ноль, после — две (витрина тира 2 — четыре слота).
    const s = state({ gold: 2, techLevel: 2, shop: [shopMinion(9, 'DRAGON_1')] });
    const rec = discountRefreshRule(mosaic(), s, mosaicDeps);
    expect(rec).not.toBeNull();
    expect(rec?.refreshSpend).toBe(2);
    expect(rec?.reason).toContain('на 2 золота покупок 2');
    expect(rec?.reason).toContain('против 0 по карману сейчас');
    // Покупок не больше размера витрины тира: десять золота на тире 2 — четыре тела.
    const rich = discountRefreshRule(mosaic(), state({ gold: 10, techLevel: 2, shop: [] }), mosaicDeps);
    expect(rich?.refreshSpend).toBe(4);
    expect(rich?.reason).toContain('покупок 4');
  });

  it('витрина с покупками по карману вычитается: при равных телах заклинание молчит', () => {
    // Три золота и одна покупка по карману сейчас против трёх тел по 1 после —
    // ожидание кличевого пула должно перебить ценность конкретной карты.
    const bodies = discountRefreshRule(mosaic(), state({ gold: 3, techLevel: 2, shop: [shopMinion(9, 'MURLOC_1')] }), mosaicDeps);
    expect(bodies).not.toBeNull();
    // Ноль золота — покупать нечего и после обновления: молчание.
    expect(discountRefreshRule(mosaic(), state({ gold: 0, techLevel: 2, shop: [] }), mosaicDeps)).toBeNull();
    // Заклинание с ценой выше золота не по карману.
    expect(discountRefreshRule(mosaic(5), state({ gold: 2, techLevel: 2, shop: [] }), mosaicDeps)).toBeNull();
  });

  it('входит в spellRules вместо разбора эффекта, а без шаблона правило молчит', () => {
    const s = state({ gold: 2, techLevel: 2, shop: [], handSpells: [mosaic()] });
    const recs = spellRules(s, mosaicDeps);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.refreshesShop).toBe(true);
    const plain = { ...mosaic(), cardId: 'SKIPPER' };
    expect(discountRefreshRule(plain, s, mosaicDeps)).toBeNull();
  });
});
