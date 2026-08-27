import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  freezeRule,
  heroPowerShotRule,
  playRules,
  shopSpellRules,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { part29Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part29 — двадцать первая партия с оверлеем (27.08.2026, 01:07–01:31,
 * Scoutmaster Tavish, 3-е место), третья на билде 250339. Пять пунктов
 * обратной связи по пяти скриншотам.
 *
 * Четыре момента из пяти — состояния ПОСРЕДИ хода, после трат, которых
 * точки решения не видят: ловятся условиями на состояние, а не номером хода.
 */
describe('part29: сила героя с целью, цена в здоровье, счёт лишнего тела', () => {
  let cards: CardIndex;
  /** Скриншот 1 — ход 3, после подъёма: золото 0/4, борд из одного дракона. */
  let shot1: GameState | null = null;
  /** Скриншот 2 — ход 5, точка решения: золото 5/5, витрина из четырёх. */
  let shot2: GameState | null = null;
  /** Скриншот 3 — ход 7, после трат: золото 0/6, в витрине Patient Scout. */
  let shot3: GameState | null = null;
  /** Скриншот 4 — ход 9, после покупки Soul Rewinder: золото 0/7. */
  let shot4: GameState | null = null;
  /** Скриншот 5 — ход 19: золото 0/10, борд из шести, второй Бранн в руке. */
  let shot5: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part29Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern' || s.hero === null) continue;

      if (s.turn === 3 && s.gold === 0 && s.techLevel === 2 && s.shop.length === 3) shot1 ??= s;
      if (s.turn === 5 && s.gold === 5 && s.shop.length === 4) shot2 ??= s;
      if (
        s.turn === 7 &&
        s.gold === 0 &&
        s.board.length === 5 &&
        s.shop.some((m) => m.cardId === 'BG24_715')
      ) {
        shot3 ??= s;
      }
      if (
        s.turn === 9 &&
        s.gold === 0 &&
        s.board.some((m) => m.cardId === 'BG26_174') &&
        s.shopSpells.some((x) => x.cardId === 'BG28_571')
      ) {
        shot4 ??= s;
      }
      if (
        s.turn === 19 &&
        s.gold === 0 &&
        s.board.length === 6 &&
        s.hand.some((m) => m.cardId === 'BG_LOE_077')
      ) {
        shot5 ??= s;
      }
    }
    finalState = reducer.snapshot();
  }, 900_000);

  it('партия дочитывается до конца: 3-е место, Тавиш, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(3);
    expect(finalState.hero?.cardId).toBe('BG22_HERO_000_SKIN_A');
    expect(finalState.buildNumber).toBe(250339);
  });

  /**
   * Пункт 1 (скриншот хода 3): «мне не рекомендует, на кого лучше применить
   * силу героя (стоит 0, даёт много вэлью на первых ходах)».
   *
   * «Lock and Load» — активная бесплатная сила с целью В ВИТРИНЕ. Прежде
   * бесплатные силы советовались только с текстом про обновление витрины
   * (part13), и про эту советник молчал всю партию — все 13 нажатий.
   */
  it('пункт 1: сила героя читается активной и бесплатной', () => {
    expect(shot1).not.toBeNull();
    const s = shot1 as GameState;
    expect(s.hero?.heroPowerCardId).toBe('BG22_HERO_000p_Alt');
    // Цены у бесплатной силы нет вовсе — тега COST на ней не бывает.
    expect(s.hero?.heroPowerCost).toBeNull();
    expect(s.hero?.heroPowerHasActivate).toBe(true);
    expect(s.hero?.heroPowerUsedThisTurn).toBe(false);
  });

  it('пункт 1: совет называет ЦЕЛЬ — того, кого игрок и выстрелил', () => {
    const s = shot1 as GameState;
    const shot = heroPowerShotRule(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(shot?.action).toBe('heroPower');
    expect(shot?.cost).toBe(0);
    // В логе (01:10:22) блок PLAY на сущности силы с
    // Target=[… cardId=BG33_886] — Tusked Camper, ровно он.
    expect(shot?.minion?.cardId).toBe('BG33_886');
    // Цель судится БОЕМ: у походника ралли при статах 2/3, у надзирателей
    // 3/3 голое тело — и в бою походник дороже.
    expect(shot?.reason).toContain('в бою он стоит');

    // И это первая строка совета: остальное на нулевом золоте молчит.
    const advice = adviseTavern(s, { cards });
    expect(advice?.recommendations[0]?.action).toBe('heroPower');
    expect(advice?.recommendations[0]?.minion?.cardId).toBe('BG33_886');
  });

  it('пункт 1: без свободного слота и после нажатия совет молчит', () => {
    const s = shot1 as GameState;
    const first = s.board[0] as Minion;
    const full = {
      ...s,
      board: Array.from({ length: DEFAULT_TAVERN_RULES.boardSize }, (_, i) => ({
        ...first,
        entityId: 900 + i,
      })),
    };
    // «When you have space next combat» — без места выстрела не будет.
    expect(heroPowerShotRule(full, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();

    const hero = s.hero as NonNullable<GameState['hero']>;
    const used = { ...s, hero: { ...hero, heroPowerUsedThisTurn: true } };
    expect(heroPowerShotRule(used, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();
  });

  /**
   * Пункт 2 (скриншот хода 5): «рекомендует заморозить лассо, хотя 5 золота
   * скорее всего последнее выгодное значение для его заморозки, дальше
   * я уже смогу покупать два существа за 6 золота».
   *
   * Ход 5 — третий ход таверны: на следующем будет ШЕСТЬ золота, и там две
   * покупки выходят и без лассо. «Два тела вместо одного» — неправда,
   * и ветка обязана проверять собственное обещание счётом.
   */
  it('пункт 2: на шести золотах следующего хода заморозка ради лассо молчит', () => {
    expect(shot2).not.toBeNull();
    const s = shot2 as GameState;
    expect(s.techLevel).toBe(2);
    expect(s.goldTotal).toBe(5);
    expect(s.shopSpells.map((x) => x.cardId)).toContain('BG28_512');

    const plan = spendPlan(s, { cards });
    expect(plan.steps.some((step) => step.recommendation.action === 'freeze')).toBe(false);

    // Ходом раньше (ход 3, пять золота следующим) тот же лассо витрину
    // держит — и это тот же счёт, а не другое правило.
    const earlier = shot1 as GameState;
    expect(earlier.shopSpells.map((x) => x.cardId)).toContain('BG28_512');
    const freeze = freezeRule(earlier, { cards }, DEFAULT_TAVERN_RULES);
    expect(freeze?.spellCardId).toBe('BG28_512');
  });

  /**
   * Пункт 3 (скриншот хода 7): «почему-то рекомендует заморозить карту 1-1».
   *
   * Patient Scout 1/1 — продажный генератор, и витрину держали ради цепочки
   * «купить-разыграть-продать» за чистых 2 (правило part25). Но следующий
   * ход даёт СЕМЬ золота: две покупки выходят и без цепочки. Счёт тот же,
   * что у заклинания.
   */
  it('пункт 3: продажный генератор витрины не держит, когда лишнего тела нет', () => {
    expect(shot3).not.toBeNull();
    const s = shot3 as GameState;
    expect(s.goldTotal).toBe(6);
    expect(s.shop.map((m) => m.cardId)).toContain('BG24_715');

    const freeze = freezeRule(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(freeze?.minion?.cardId).not.toBe('BG24_715');
    const plan = spendPlan(s, { cards });
    expect(plan.steps.some((step) => step.recommendation.minion?.cardId === 'BG24_715')).toBe(
      false,
    );
  });

  /**
   * Пункт 4 (скриншот хода 9): «не рекомендует купить карту за здоровье,
   * которая будет для меня бесплатна с учётом существа, который отменяет
   * урон по мне».
   *
   * Hasty Excavation `BG28_571` — `BACON_COSTS_HEALTH_TO_BUY=1` при `COST=3`.
   * Прежде цена сравнивалась с золотом, и заклинание было невидимо целиком.
   */
  it('пункт 4: цена в здоровье читается тегом, а не текстом', () => {
    expect(shot4).not.toBeNull();
    const s = shot4 as GameState;
    const spell = s.shopSpells.find((x) => x.cardId === 'BG28_571');
    expect(spell?.costsHealth).toBe(true);
    expect(spell?.cost).toBe(3);
    expect(s.gold).toBe(0);
  });

  it('пункт 4: при «перемотчике» на борде покупка советуется и золота не стоит', () => {
    const s = shot4 as GameState;
    // Soul Rewinder «After your hero takes damage, rewind it…» — он и есть
    // «существо, который отменяет урон по мне».
    expect(s.board.some((m) => m.cardId === 'BG26_174')).toBe(true);

    const buy = shopSpellRules(s, { cards }, DEFAULT_TAVERN_RULES).find(
      (r) => r.spellCardId === 'BG28_571',
    );
    expect(buy?.action).toBe('buy');
    expect(buy?.cost).toBe(0);
    expect(buy?.grantsGold).toBe(1);
    expect(buy?.reason).toContain('здоровья');

    // Без перемотчика на борде курса «здоровье → золото» у нас нет,
    // и совет честно молчит.
    const noRewinder = { ...s, board: s.board.filter((m) => m.cardId !== 'BG26_174') };
    expect(
      shopSpellRules(noRewinder, { cards }, DEFAULT_TAVERN_RULES).some(
        (r) => r.spellCardId === 'BG28_571',
      ),
    ).toBe(false);
  });

  /**
   * Пункт 5 (скриншот хода 19): «непонятно, зачем ставить Бранна, ведь
   * на следующий ход мне придётся его продавать, если я не найду 3 копию».
   *
   * Второй Бранн 2/4 при борде из 18/16, 24/23 и 25/34 стоял верхней строкой
   * с 16.0 очков, три из которых — бонус «вторая копия». Копией он остаётся
   * и в руке, а последний слот тратится навсегда.
   */
  it('пункт 5: ставка на тройку в последний слот не выставляется', () => {
    expect(shot5).not.toBeNull();
    const s = shot5 as GameState;
    expect(s.board).toHaveLength(6);
    expect(s.board.some((m) => m.cardId === 'BG_LOE_077')).toBe(true);
    expect(s.hand.map((m) => m.cardId)).toContain('BG_LOE_077');

    expect(
      playRules(s, { cards }, DEFAULT_TAVERN_RULES).some((r) => r.minion?.cardId === 'BG_LOE_077'),
    ).toBe(false);
    const plan = spendPlan(s, { cards });
    expect(plan.steps.some((step) => step.recommendation.action === 'play')).toBe(false);
  });

  it('пункт 5: там, где слот не последний, ставка выкладывается по-прежнему', () => {
    const s = shot5 as GameState;
    // Борд из четырёх, и копия Бранна на нём остаётся: без неё ставки
    // не было бы вовсе и тест проверял бы не то, ради чего написан.
    const roomy = {
      ...s,
      board: [
        ...s.board.filter((m) => m.cardId === 'BG_LOE_077'),
        ...s.board.filter((m) => m.cardId !== 'BG_LOE_077').slice(0, 3),
      ],
    };
    const play = playRules(roomy, { cards }, DEFAULT_TAVERN_RULES).find(
      (r) => r.minion?.cardId === 'BG_LOE_077',
    );
    expect(play).toBeDefined();
    // Бонус за копию в очки розыгрыша не входит: копия у нас уже есть,
    // и в руке она считается наравне с бордом.
    expect(play?.reason).toContain('ставка на тройку живёт и в руке');
  });
});
