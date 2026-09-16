import { describe, expect, it } from 'vitest';

import { adviseTavern, heroPowerDigRule } from '../../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../../src/advisors/tavern/spend.js';
import { createCardIndex } from '../../../src/data/cards.js';
import { EMPTY_STATE, type GameState, type Hero } from '../../../src/state/types.js';
import { minion } from '../../minions.js';

/**
 * Сила Капитана Юдоры «Зарытое сокровище» (part55): «Dig for a Golden
 * minion! (4 Digs left.)», цена 1. Награда — золотой миньон тиров
 * от первого до своего, приходит каждым четвёртым нажатием; живой остаток —
 * `TAG_SCRIPT_DATA_NUM_1` на силе (`heroPowerScriptData[0]`).
 *
 * Фикстурная сторона — `test/state/part55.test.ts`.
 */
const cards = createCardIndex([
  // Текст — дословно снапшот, с разметкой и переносом.
  {
    id: 'DIG',
    name: 'Buried Treasure',
    type: 'Hero_power',
    cost: 1,
    text: '[x] Dig for a Golden minion!\n<i>(4 Digs left.)</i>',
  },
  { id: 'OTHER', name: 'Other Power', type: 'Hero_power', cost: 1, text: 'Gain 1 Gold.' },
  { id: 'T1', name: 'Первый', type: 'Minion', techLevel: 1, attack: 2, health: 2, races: [], isBaconPool: true },
  { id: 'T1B', name: 'Первый-2', type: 'Minion', techLevel: 1, attack: 3, health: 1, races: [], isBaconPool: true },
  { id: 'T2', name: 'Второй', type: 'Minion', techLevel: 2, attack: 4, health: 4, races: [], isBaconPool: true },
  { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 1, attack: 2, health: 2, races: [] },
]);
const deps = { cards };

const eudora = (patch: Partial<Hero> = {}): Hero => ({
  entityId: 1,
  cardId: 'TB_BaconShop_HERO_64',
  health: 30,
  armor: 0,
  damage: 0,
  heroPowerCardId: 'DIG',
  heroPowerEntityId: 198,
  heroPowerCost: 1,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: true,
  heroPowerExhausted: false,
  heroPowerDisabled: false,
  heroPowerScriptData: [4],
  ...patch,
});

function state(patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn: 3,
    techLevel: 1,
    gold: 4,
    goldTotal: 4,
    hero: eudora(),
    ...patch,
  };
}

const withLeft = (left: number | null, patch: Partial<GameState> = {}): GameState =>
  state({ hero: eudora({ heroPowerScriptData: left === null ? [] : [left] }), ...patch });

describe('раскопка Юдоры (heroPowerDigRule, part55)', () => {
  it('доля награды — по остатку счётчика: последняя раскопка стоит целой награды', () => {
    const full = heroPowerDigRule(withLeft(1), deps);
    const quarter = heroPowerDigRule(withLeft(4), deps);
    const half = heroPowerDigRule(withLeft(2), deps);
    expect(full).not.toBeNull();
    expect(quarter?.score).toBeCloseTo((full?.score ?? 0) / 4, 9);
    expect(half?.score).toBeCloseTo((full?.score ?? 0) / 2, 9);
    expect(full?.action).toBe('heroPower');
    expect(full?.cost).toBe(1);
    expect(full?.reason).toContain('раскопка 4 из 4');
    expect(full?.reason).toContain('приходит этим нажатием');
    expect(quarter?.reason).toContain('раскопка 1 из 4');
    expect(quarter?.reason).toContain('нажимать каждый ход');
  });

  it('без тега остаток берётся из текста — четыре раскопки', () => {
    expect(heroPowerDigRule(withLeft(null), deps)?.score).toBeCloseTo(
      heroPowerDigRule(withLeft(4), deps)?.score ?? NaN,
      9,
    );
  });

  it('награда — средний миньон тиров 1..свой плюс бонус собранной тройки', () => {
    // Бонус тройки считается весом `copiesBonus`, своего веса у правила нет.
    const noTriple = { ...DEFAULT_TAVERN_RULES, copiesBonus: [0, 3, 0] };
    const withTriple = heroPowerDigRule(withLeft(2), deps)?.score ?? NaN;
    const without = heroPowerDigRule(withLeft(2), deps, noTriple)?.score ?? NaN;
    expect(withTriple - without).toBeCloseTo(12 / 2, 9);

    // Тир таверны расширяет пул: на втором тире в него входит тело 4/4.
    const tier1 = heroPowerDigRule(withLeft(1), deps, noTriple)?.score ?? NaN;
    const tier2 = heroPowerDigRule(withLeft(1, { techLevel: 2 }), deps, noTriple)?.score ?? NaN;
    expect(tier2).toBeGreaterThan(tier1);
    expect(heroPowerDigRule(withLeft(1, { techLevel: 2 }), deps)?.reason).toContain('тиров 1–2');
  });

  it('молчит, когда нажать нельзя или нечем', () => {
    expect(heroPowerDigRule(state({ hero: eudora({ heroPowerExhausted: true }) }), deps)).toBeNull();
    expect(heroPowerDigRule(state({ hero: eudora({ heroPowerLocked: true }) }), deps)).toBeNull();
    expect(heroPowerDigRule(state({ gold: 0 }), deps)).toBeNull();
    // Тега COST нет вовсе — правило такую силу не судит (D083).
    expect(heroPowerDigRule(state({ hero: eudora({ heroPowerCost: null }) }), deps)).toBeNull();
    // Другая сила и отсутствие героя.
    expect(heroPowerDigRule(state({ hero: eudora({ heroPowerCardId: 'OTHER' }) }), deps)).toBeNull();
    expect(heroPowerDigRule(state({ hero: null }), deps)).toBeNull();
    // Ноль — счётчик на сбросе: игра тут же ставит 4, нулём он не стоит.
    expect(heroPowerDigRule(withLeft(0), deps)).toBeNull();
  });

  it('награда, до которой партия не доживёт, не стоит ничего', () => {
    // Ход таверны 14 (наш 27): по замеру горизонта впереди 0.4 хода.
    expect(heroPowerDigRule(withLeft(3, { turn: 27, gold: 20 }), deps)).toBeNull();
    // А последняя раскопка приходит сразу — её горизонт не касается.
    expect(heroPowerDigRule(withLeft(1, { turn: 27, gold: 20 }), deps)).not.toBeNull();
  });

  it('на полном борде награде нужно место — вычитается жертва, но только у последней раскопки', () => {
    // Тела вне пула: копии пула меняли бы саму награду (бонус за копии).
    const bodies = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        minion(10 + i, { cardId: 'BODY', attack: 2, health: 2, techLevel: 1, zonePos: i + 1 }),
      );
    const six = heroPowerDigRule(withLeft(1, { board: bodies(6) }), deps)?.score ?? NaN;
    const crowded = heroPowerDigRule(withLeft(1, { board: bodies(7) }), deps);
    expect(crowded?.score).toBeLessThan(six);
    expect(crowded?.reason).toContain('борд полон');
    // Раскопка без награды места не просит.
    expect(heroPowerDigRule(withLeft(3, { board: bodies(7) }), deps)?.score).toBeCloseTo(
      heroPowerDigRule(withLeft(3, { board: bodies(6) }), deps)?.score ?? NaN,
      9,
    );
  });

  it('входит в список советов и в план, когда золото остаётся после покупки', () => {
    const s = withLeft(4, {
      shop: [minion(20, { cardId: 'T1', attack: 2, health: 2, techLevel: 1 })],
      tavernUpgradeCost: 99,
    });
    const recs = adviseTavern(s, deps)?.recommendations ?? [];
    expect(recs.some((r) => r.action === 'heroPower')).toBe(true);
    const plan = spendPlan(s, deps);
    expect(plan.steps.map((st) => st.recommendation.action)).toContain('heroPower');
    expect(plan.goldLeft).toBe(0);
  });
});
