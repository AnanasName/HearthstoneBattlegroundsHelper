import { describe, expect, it } from 'vitest';

import { spellRules, type Recommendation } from '../../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../../src/advisors/tavern/rules.js';
import { applyRecommendation, spendPlan } from '../../../src/advisors/tavern/spend.js';
import { createCardIndex } from '../../../src/data/cards.js';
import { EMPTY_STATE, type GameState, type Hero, type Minion } from '../../../src/state/types.js';
import { spendPlanLine } from '../../../src/ui/format.js';
import { minion } from '../../minions.js';

/**
 * План трат хода: цепочка тех же правил на гипотетических состояниях.
 *
 * Проверяется две вещи: переходы состояния (что советы делают с бордом,
 * рукой, витриной и золотом) и сама цепочка — что она не повторяет действий,
 * не выходит за золото и честно обрывается там, где витрина становится
 * неизвестной.
 */

const cards = createCardIndex([
  { id: 'BODY_1', name: 'Тело', type: 'Minion', techLevel: 2, races: ['MURLOC'], isBaconPool: true },
  { id: 'BODY_2', name: 'Другое тело', type: 'Minion', techLevel: 2, races: ['MURLOC'], isBaconPool: true },
  { id: 'BODY_3', name: 'Третье тело', type: 'Minion', techLevel: 3, races: ['MURLOC'], isBaconPool: true },
  // Мурлок четвёртого тира: обновление при золоте, на которое не купить,
  // советуется только под цель заморозки, и «соплеменник» — только если
  // племя есть в пуле своего тира (part27).
  { id: 'BODY_4', name: 'Четвёртое тело', type: 'Minion', techLevel: 4, races: ['MURLOC'], isBaconPool: true },
  { id: 'JUNK', name: 'Мусор', type: 'Minion', techLevel: 1, races: [], isBaconPool: true },
]);
const deps = { cards };

const hero = (): Hero => ({
  entityId: 1,
  cardId: 'TB_BaconShop_HERO_60',
  health: 40,
  armor: 0,
  damage: 0,
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
    turn: 9,
    techLevel: 3,
    gold: 6,
    goldTotal: 6,
    hero: hero(),
    ...patch,
  };
}

const shopMinion = (id: number, cardId: string, patch: Partial<Minion> = {}): Minion =>
  minion(id, { cardId, techLevel: cards.info(cardId)?.techLevel ?? 1, ...patch });

const buy = (m: Minion, patch: Partial<Recommendation> = {}): Recommendation => ({
  action: 'buy',
  minion: m,
  score: 10,
  cost: DEFAULT_TAVERN_RULES.minionCost,
  requiresSlot: false,
  sellFirst: null,
  reason: 'тест',
  ...patch,
});

describe('переходы состояния для плана трат', () => {
  it('покупка уводит миньона из витрины на борд и списывает золото', () => {
    const m = shopMinion(10, 'BODY_1');
    const s = state({ shop: [m], board: [] });
    const applied = applyRecommendation(s, buy(m));

    expect(applied?.state.gold).toBe(3);
    expect(applied?.state.shop).toHaveLength(0);
    expect(applied?.state.board.map((x) => x.entityId)).toEqual([10]);
    expect(applied?.opaque).toBe(false);
    expect(applied?.terminal).toBe(false);
  });

  it('на полном борде покупка ложится в руку, а продажа возвращает золото', () => {
    const m = shopMinion(20, 'BODY_2');
    const victim = shopMinion(1, 'JUNK');
    const full = [victim, ...Array.from({ length: 6 }, (_, i) => shopMinion(i + 2, 'BODY_1'))];

    const toHand = applyRecommendation(state({ shop: [m], board: full }), buy(m));
    expect(toHand?.state.hand.map((x) => x.entityId)).toEqual([20]);
    expect(toHand?.state.board).toHaveLength(7);

    const withSale = applyRecommendation(
      state({ shop: [m], board: full }),
      buy(m, { sellFirst: victim }),
    );
    // Три золота ушло, одно вернулось продажей.
    expect(withSale?.state.gold).toBe(6 - 3 + DEFAULT_TAVERN_RULES.sellGold);
    expect(withSale?.state.board.some((x) => x.entityId === victim.entityId)).toBe(false);
    expect(withSale?.state.board.map((x) => x.entityId)).toContain(20);
  });

  it('подъём таверны поднимает тир и убирает кнопку: дважды за ход не поднимаются', () => {
    const s = state({ gold: 7, tavernUpgradeCost: 7, tavernUpgradeTarget: 4 });
    const applied = applyRecommendation(s, {
      action: 'levelUp',
      minion: null,
      score: 5,
      cost: 7,
      requiresSlot: false,
      sellFirst: null,
      reason: 'тест',
    });

    expect(applied?.state.techLevel).toBe(4);
    expect(applied?.state.gold).toBe(0);
    expect(applied?.state.tavernUpgradeCost).toBeNull();
    expect(applied?.state.techLevelUpTurn).toBe(9);
  });

  it('обновление витрины план заканчивает: дальше витрина неизвестна', () => {
    const applied = applyRecommendation(state(), {
      action: 'reroll',
      minion: null,
      score: 1,
      cost: 1,
      requiresSlot: false,
      sellFirst: null,
      reason: 'тест',
    });
    expect(applied?.terminal).toBe(true);
    expect(applied?.state.shop).toHaveLength(0);
  });

  it('заморозка ничего не тратит и заканчивает план', () => {
    // Решение о заморозке принимается в конце хода, когда золото потрачено
    // и стало видно, что осталось не по карману.
    const applied = applyRecommendation(state(), {
      action: 'freeze',
      minion: null,
      score: 4,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason: 'тест',
    });
    expect(applied?.terminal).toBe(true);
    expect(applied?.state.gold).toBe(6);
  });

  it('«ничего» и продажа в план не входят', () => {
    for (const action of ['pass', 'sell'] as const) {
      const rec: Recommendation = {
        action,
        minion: null,
        score: 1,
        cost: 0,
        requiresSlot: false,
        sellFirst: null,
        reason: 'тест',
      };
      expect(applyRecommendation(state(), rec)).toBeNull();
    }
  });
});

describe('план трат хода', () => {
  it('на шесть золота собирает две покупки, а не одну', () => {
    const s = state({
      gold: 6,
      board: [shopMinion(1, 'BODY_1')],
      shop: [
        shopMinion(10, 'BODY_3', { attack: 5, health: 5 }),
        shopMinion(11, 'BODY_2', { attack: 4, health: 4 }),
        shopMinion(12, 'JUNK', { attack: 1, health: 1 }),
      ],
    });
    const plan = spendPlan(s, deps);

    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.map((st) => st.recommendation.action)).toEqual(['buy', 'buy']);
    // Дороже — раньше: цепочка идёт по тому же ранжированию, что список.
    expect(plan.steps[0]?.recommendation.minion?.entityId).toBe(10);
    expect(plan.steps[1]?.recommendation.minion?.entityId).toBe(11);
    expect(plan.goldLeft).toBe(0);
    expect(plan.truncated).toBe(false);
  });

  it('план из одного шага возвращается как есть: обрезать его — дело интерфейса', () => {
    // Обрезка внутри модуля ломала замер: план из одного действия он читал бы
    // как «ничего не делать» и сравнивал с пустым набором.
    const s = state({
      gold: 3,
      board: [shopMinion(1, 'BODY_1')],
      shop: [shopMinion(10, 'BODY_3', { attack: 5, health: 5 })],
    });
    const plan = spendPlan(s, deps);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.recommendation.action).toBe('buy');
  });

  it('одно и то же действие в план дважды не попадает', () => {
    // Активация носителя оставляет его на борде, а «нажато в этом ходу»
    // читается из блоков лога, которых у гипотетического состояния нет.
    const s = state({
      gold: 10,
      board: [shopMinion(1, 'BODY_1')],
      shop: [
        shopMinion(10, 'BODY_3', { attack: 5, health: 5 }),
        shopMinion(11, 'BODY_2', { attack: 4, health: 4 }),
      ],
    });
    const plan = spendPlan(s, deps);
    const keys = plan.steps.map(
      (st) => `${st.recommendation.action}:${String(st.recommendation.minion?.entityId)}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('строка плана называет судьбу остатка золота и обрыв на обновлении', () => {
    const m = shopMinion(10, 'BODY_3', { attack: 5, health: 5 });
    const step = {
      recommendation: buy(m),
      goldBefore: 7,
      goldAfter: 4,
      opaque: false,
      stateAfter: state({ gold: 4 }),
    };

    const burning = spendPlanLine(
      { steps: [step, { ...step, goldBefore: 4, goldAfter: 1 }], goldLeft: 2, truncated: false },
      cards,
    );
    expect(burning).toContain('ПЛАН ХОДА');
    expect(burning).toContain('→');
    expect(burning).toContain('остаётся 2 — сгорит');

    // Оборвавшийся план про остаток молчит: что купить дальше, решит
    // новая витрина, а не мы.
    const truncated = spendPlanLine(
      { steps: [step, { ...step, opaque: true }], goldLeft: 6, truncated: true },
      cards,
    );
    expect(truncated).toContain('дальше по новой витрине');
    expect(truncated).not.toContain('сгорит');
  });

  it('длинный план обрезается для показа, но сам план полный', () => {
    // Шесть шагов с целями заклинаний занимают в оверлее три строки из трёх
    // и вытесняют расстановку. Обрезка живёт в форматировании, а не в плане:
    // замер и живой режим считают по полному плану.
    const m = shopMinion(10, 'BODY_3', { attack: 5, health: 5 });
    const step = {
      recommendation: buy(m),
      goldBefore: 9,
      goldAfter: 6,
      opaque: false,
      stateAfter: state({ gold: 6 }),
    };
    const long = spendPlanLine(
      { steps: [step, step, step, step, step, step], goldLeft: 0, truncated: false },
      cards,
    );
    expect(long).toContain('…и ещё 2');
    expect(long.split('→')).toHaveLength(5);
  });

  it('в лейте план обрывается на обновлении витрины и говорит об этом', () => {
    // Тир от lateRerollTier: обновление — это поиск конкретной карты под
    // заморозку, и остаток в одно золото ему не помеха — пока есть, кого
    // искать: после двух покупок на борде три мурлока, и цель — соплеменник
    // своего тира (part27: без названной цели обновление молчит).
    const s = state({
      techLevel: DEFAULT_TAVERN_RULES.lateRerollTier,
      gold: 7,
      board: [shopMinion(1, 'BODY_1')],
      shop: [
        shopMinion(10, 'BODY_3', { attack: 5, health: 5 }),
        shopMinion(11, 'BODY_2', { attack: 4, health: 4 }),
      ],
    });
    const plan = spendPlan(s, deps);
    expect(plan.truncated).toBe(true);
    expect(plan.steps.at(-1)?.recommendation.action).toBe('reroll');
    expect(spendPlanLine(plan, cards)).toContain('дальше по новой витрине');
  });

  it('в ранней партии план не тратит остаток на обновление (part18, ход 7)', () => {
    // Игрок указал прямо: в ранней игре обновлять нежелательно. Обновление
    // на последнее золото — это взгляд на витрину, покупать с которой уже
    // нечем, а заморозить найденное значит отдать бесплатное обновление.
    const s = state({
      techLevel: DEFAULT_TAVERN_RULES.lateRerollTier - 1,
      gold: 7,
      board: [shopMinion(1, 'BODY_1')],
      shop: [
        shopMinion(10, 'BODY_3', { attack: 5, health: 5 }),
        shopMinion(11, 'BODY_2', { attack: 4, health: 4 }),
      ],
    });
    const plan = spendPlan(s, deps);
    expect(plan.steps.some((st) => st.recommendation.action === 'reroll')).toBe(false);
    expect(plan.goldLeft).toBe(1);
    expect(spendPlanLine(plan, cards)).toContain('остаётся 1 — сгорит');
  });
});

describe('дневной заряд хранителя в плане', () => {
  /**
   * Заряд читается как `scriptData[0] ?? 1`: тега нет — заряд есть. Значит,
   * расход обязан ЗАПИСАТЬСЯ и туда, где массива тегов не было вовсе, —
   * иначе следующий шаг цепочки снова видит заряд и обещает постоянство
   * второй раз за ход (part21).
   */
  const keeper = (scriptData: readonly (number | null)[]) =>
    minion(7, { cardId: 'BODY_1', scriptData });

  const castOn = (target: Minion): Recommendation => ({
    action: 'play',
    minion: null,
    spellCardId: 'TRIDENT',
    score: 5,
    cost: 0,
    requiresSlot: false,
    sellFirst: null,
    reason: 'тест',
    targetMinion: target,
    spendsMagnetCharge: true,
  });

  it('заряд списывается и когда живого тега не было', () => {
    const target = keeper([]);
    const s = state({ board: [target] });
    const next = applyRecommendation(s, castOn(target));
    expect(next?.state.board[0]?.scriptData[0]).toBe(0);
  });

  it('заряд списывается и из живого тега', () => {
    const target = keeper([1, null]);
    const s = state({ board: [target] });
    const next = applyRecommendation(s, castOn(target));
    expect(next?.state.board[0]?.scriptData[0]).toBe(0);
    // Соседние теги не тронуты.
    expect(next?.state.board[0]?.scriptData[1]).toBeNull();
  });

  it('совет без заряда борда не трогает', () => {
    const target = keeper([1]);
    const s = state({ board: [target] });
    const next = applyRecommendation(s, { ...castOn(target), spendsMagnetCharge: false });
    expect(next?.state.board[0]?.scriptData[0]).toBe(1);
  });
});

describe('золото заклинания доезжает до следующего шага', () => {
  /**
   * `grantsGold` — ВАЛОВОЕ золото из текста: цену `applyRecommendation`
   * вычитает само, общей для всех шагов строкой. Чистое значение означало
   * бы вычесть цену дважды, и обещанная советом покупка снова не
   * открывалась бы — тот же симптом part24, ради которого поле заводилось.
   */
  const idx = createCardIndex([
    { id: 'COIN', name: 'Щедрая монета', type: 'Spell', text: 'Gain 3 Gold.' },
    {
      id: 'BODY',
      name: 'Тело',
      type: 'Minion',
      techLevel: 3,
      races: [],
      isBaconPool: true,
      attack: 4,
      health: 4,
    },
  ]);
  const d = { cards: idx };
  // Цена 2 при трёх золотых из текста: чистыми 1, валовыми 3. На этой
  // разнице покупка за 3 либо открывается, либо нет.
  const coin = {
    entityId: 40,
    cardId: 'COIN',
    cost: 2,
    scriptData: [] as readonly (number | null)[],
    zonePos: 0,
    unplayable: false, costsHealth: false,
  };
  const withCoin = (): GameState =>
    state({
      gold: 2,
      goldTotal: 6,
      techLevel: 3,
      board: [],
      shop: [minion(20, { cardId: 'BODY', attack: 4, health: 4, techLevel: 3 })],
      handSpells: [coin],
    });

  it('совет несёт валовое золото, а остаток считается через цену', () => {
    // Два золота: покупки за 3 не хватает, с монетой хватит ровно.
    const s = withCoin();

    const rec = spellRules(s, d).find((r) => r.spellCardId === 'COIN');
    expect(rec?.grantsGold).toBe(3);

    // 2 − 2 + 3 = 3: на покупку за 3 хватает ровно.
    const next = applyRecommendation(s, rec as Recommendation);
    expect(next?.state.gold).toBe(3);
    // `goldSpent` — приращение остатка, не ниже нуля: монета принесла
    // больше, чем стоила, и «потрачено» осталось нулём (с `TEMP_RESOURCES`
    // остаток бывает выше максимума, и разность `goldTotal − gold` врала бы).
    expect(next?.state.goldSpent).toBe(0);
  });

  it('заклинание не по карману не советуется — как и всё остальное', () => {
    // Найдено не ревью, а при разборе соседней правки: ветка усиления
    // проверяет «по карману ли», а экономическая — не проверяла.
    const poor = state({
      gold: 1,
      goldTotal: 6,
      techLevel: 3,
      board: [],
      shop: [minion(20, { cardId: 'BODY', attack: 4, health: 4, techLevel: 3 })],
      handSpells: [coin],
    });
    expect(spellRules(poor, d).some((r) => r.spellCardId === 'COIN')).toBe(false);

    // Двух золотых хватает — совет возвращается.
    expect(spellRules(withCoin(), d).some((r) => r.spellCardId === 'COIN')).toBe(true);
  });

  it('план и вправду делает обещанную покупку следующим шагом', () => {
    const plan = spendPlan(withCoin(), d);
    const actions = plan.steps.map((step) => step.recommendation.action);
    expect(actions.slice(0, 2)).toEqual(['play', 'buy']);
  });
});

describe('счётчик силы «после N покупок» в плане (part34)', () => {
  const brand = (scriptData: readonly (number | null)[]): Hero => ({
    ...hero(),
    heroPowerCardId: 'BRAND',
    heroPowerEntityId: 226,
    heroPowerScriptData: scriptData,
  });

  it('покупка, которую сила засчитывает, уменьшает остаток — и когда тега ещё не было', () => {
    const m = shopMinion(20, 'BODY_1');
    const fresh = applyRecommendation(state({ hero: brand([]), shop: [m] }), buy(m, { heroPowerBuyLeft: 3 }));
    expect(fresh?.state.hero?.heroPowerScriptData).toEqual([3]);
    const live = applyRecommendation(state({ hero: brand([2, null]), shop: [m] }), buy(m, { heroPowerBuyLeft: 1 }));
    expect(live?.state.hero?.heroPowerScriptData).toEqual([1, null]);
  });

  it('покупка без отметки героя не трогает — та же ссылка', () => {
    const m = shopMinion(20, 'BODY_1');
    const s = state({ hero: brand([2]), shop: [m] });
    const applied = applyRecommendation(s, buy(m));
    expect(applied?.state.hero).toBe(s.hero);
  });
});
