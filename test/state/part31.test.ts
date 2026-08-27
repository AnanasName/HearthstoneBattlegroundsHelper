import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, darkGiftRule, shopSpellRules } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part31Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part31 — двадцать третья партия с оверлеем (27.08.2026, 21:27–21:50,
 * Йогг-Сарон, наги, 6-е место), пятая на билде 250339. Два пункта
 * по одному скриншоту хода 13 — состоянию ПОСРЕДИ хода: борд полон
 * (седьмой — Rodeo Performer 5/6), золото 9/9, витрина из пяти миньонов
 * и A New Sprout, в руке Water Droplet, Mini-Trident и Thaumaturgy.
 * Точка решения этого не видит (первой «тратой» хода стала продажа
 * Rodeo Performer), поэтому момент ловится условиями на состояние.
 */
describe('part31: цена придержанного заряда дара, миньон в руку на полном борде', () => {
  let cards: CardIndex;
  /** Скриншот — ход 13 посреди: борд 7, золото 9/9, витрина 5 + A New Sprout. */
  let shot: GameState | null = null;
  /** Ход 7, точка решения: шесть золота, дар только открылся (4-й ход таверны). */
  let turn7: GameState | null = null;
  /** Ход 19, до нажатия: десять золота, три заряда, 10-й ход таверны. */
  let turn19: GameState | null = null;
  /** Ход 21, до нажатия: два заряда — первый нажат на ходу 19. */
  let turn21: GameState | null = null;
  /** Ход 23, до нажатия: последний заряд. */
  let turn23: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part31Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern' || s.hero === null) continue;

      if (
        s.turn === 13 &&
        s.gold === 9 &&
        s.board.length === 7 &&
        s.shop.length === 5 &&
        s.shopSpells.some((x) => x.cardId === 'BG33_101') &&
        s.handSpells.length === 2
      ) {
        shot = s;
      }
      if (s.turn === 7 && s.gold === 6 && s.shop.length >= 4) {
        turn7 = s;
      }
      // Флаг «нажато» поднимается строкой BLOCK_START, раньше списания
      // золота (part30) — поэтому «до нажатия» это условие на флаг,
      // а не на золото.
      for (const [turn, set] of [
        [19, (v: GameState) => (turn19 = v)],
        [21, (v: GameState) => (turn21 = v)],
        [23, (v: GameState) => (turn23 = v)],
      ] as const) {
        if (s.turn === turn && s.gold === 10 && s.shop.length >= 5 && !s.darkGiftUsedThisTurn) {
          set(s);
        }
      }
    }
    finalState = reducer.snapshot();
  }, 900_000);

  it('партия дочитывается до конца: 6-е место, Йогг-Сарон, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(6);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_35_SKIN_E');
    expect(finalState.buildNumber).toBe(250339);
  });

  it('скриншот: борд полон, золото 9/9, в витрине A New Sprout за 3', () => {
    expect(shot).not.toBeNull();
    const s = shot as GameState;
    expect(s.board.map((m) => m.cardId)).toContain('BG28_550');
    expect(s.shopSpells.find((x) => x.cardId === 'BG33_101')?.cost).toBe(3);
    expect(s.darkGiftCost).toBe(3);
    expect(s.darkGiftCharges).toBe(3);
  });

  /**
   * Пункт 1: «почему как только тёмный дар открывается, его почти сразу
   * рекомендуют? он становится сильнее с каждым ходом, и дальше можно
   * раскапывать больше ключевых существ».
   *
   * Заряды — живой тег кнопки, и игрок все три нажал на 10-м, 11-м
   * и 12-м ходах таверны: 21:42:51 (ход 19), 21:45:20 (ход 21),
   * 21:47:41 (ход 23) — NUM_2 3 → 2 → 1 → 0.
   */
  it('пункт 1: заряды читаются с кнопки и убывают по нажатиям', () => {
    expect(turn19).not.toBeNull();
    expect(turn21).not.toBeNull();
    expect(turn23).not.toBeNull();
    expect((turn19 as GameState).darkGiftCharges).toBe(3);
    expect((turn21 as GameState).darkGiftCharges).toBe(2);
    expect((turn23 as GameState).darkGiftCharges).toBe(1);
    // После третьего нажатия кнопка с нулём зарядов кнопкой не считается.
    expect(finalState.darkGiftCost).toBeNull();
  });

  it('пункт 1: на ходу 7 (4-й ход таверны) дар молчит — заряд стоит дороже тела', () => {
    expect(turn7).not.toBeNull();
    const s = turn7 as GameState;
    expect(s.darkGiftCost).toBe(3);
    // Тело тира 2–3 сейчас против тела тира 5–6 на 10-м ходу таверны при
    // 8.3 ходах впереди: цена спешки больше самого тела.
    expect(darkGiftRule(s, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();
    const plan = spendPlan(s, { cards });
    expect(plan.steps.some((st) => st.recommendation.action === 'darkGift')).toBe(false);
  });

  it('пункт 1: на скриншоте дар уступает покупке и называет цену спешки', () => {
    const s = shot as GameState;
    const rec = darkGiftRule(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec).not.toBeNull();
    // Тело тира 4 — 14.4; на 10-м ходу таверны (впереди 5.3 хода при трёх
    // зарядах) дар даёт тир 5–6 — 19.5: спешка стоит 5.2, остаётся 9.2.
    expect(rec?.score).toBeCloseTo(9.2, 0);
    expect(rec?.reason).toContain('заряд лучше придержать');
    expect(rec?.reason).toContain('впереди ещё 5.3 ходов таверны');
    expect(rec?.reason).toContain('тир 5 или 6');

    // Верхняя строка — покупка Thorned Trailblazer (12.5 с продажей
    // Tusked Camper), а не дар (прежде 14.4 против 14.0).
    const advice = adviseTavern(s, { cards });
    const top = advice?.recommendations[0];
    expect(top?.action).toBe('buy');
    expect(top?.minion?.cardId).toBe('BG31_327');
  });

  it('пункт 1: с 10-го хода таверны цена спешки — ноль, и дар жмётся', () => {
    for (const s of [turn19, turn21] as GameState[]) {
      const rec = darkGiftRule(s, { cards }, DEFAULT_TAVERN_RULES);
      expect(rec).not.toBeNull();
      expect(rec?.reason).toContain('сильнее предложение уже не станет');
      expect(rec?.reason).toContain('тир 5 или 6');
      // Верхняя строка списка — дар: ровно на этих ходах игрок и жал.
      const advice = adviseTavern(s, { cards });
      expect(advice?.recommendations[0]?.action).toBe('darkGift');
    }
  });

  /**
   * Пункт 2: «почему предлагает купить заклинание из 1 таверны, оно
   * кажется очень слабым для данной стадии игры?»
   *
   * A New Sprout `BG33_101` — «Discover a Tier 1 minion» за 3: миньон
   * приходит В РУКУ, а борд полон — место ему освободит только продажа
   * слабейшего (Tusked Camper, 9.0), и тело первого тира (7.1) этого
   * не окупает. Прежде жертва вычиталась у ветви модального миньона
   * (part28), но не у заклинания витрины, и план начинался с ростка.
   */
  it('пункт 2: «Discover a Tier 1 minion» на полном борде молчит', () => {
    const s = shot as GameState;
    const recs = shopSpellRules(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(recs.some((r) => r.spellCardId === 'BG33_101')).toBe(false);

    const plan = spendPlan(s, { cards });
    expect(plan.steps.some((st) => st.recommendation.spellCardId === 'BG33_101')).toBe(false);
    expect(plan.steps[0]?.recommendation.spellCardId).toBeUndefined();
  });

  it('пункт 2: на неполном борде тот же росток остаётся дешёвым телом, а не молчит', () => {
    const s = shot as GameState;
    const room = { ...s, board: s.board.slice(0, 6) };
    const rec = shopSpellRules(room, { cards }, DEFAULT_TAVERN_RULES).find(
      (r) => r.spellCardId === 'BG33_101',
    );
    expect(rec).not.toBeUndefined();
    expect(rec?.score).toBeCloseTo(7.1, 0);
    expect(rec?.reason).toContain('средний миньон тира 1');
  });
});
