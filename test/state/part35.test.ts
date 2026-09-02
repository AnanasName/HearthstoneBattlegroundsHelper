import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  bodiesAffordable,
  buyCostOf,
  buyRules,
  discountRefreshRule,
  spellRules,
} from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState, HandSpell } from '../../src/state/types.js';
import { part35Segment } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part35 — двадцать седьмая партия с оверлеем (28.08.2026, 17:51–18:17,
 * Изера `TB_BaconShop_HERO_53`, драконы, 5-е место), девятая на билде
 * 250339 и первая после part1 с перезапуском клиента посреди партии:
 * сегмент 1 обрывается на ходу 19 (18:08:45), сегмент 2 начинается дампом
 * переподключения (18:10:19) и доигрывается до финала.
 *
 * Пункт игрока один, по скриншоту хода 19 (18:07, после подъёма на тир 5
 * за 8: золото 2/10, борд из семи драконов, витрина по три): «не
 * рекомендует разыграть чародейское заклинание, которое сильно выгоднее,
 * чем обновление». Оверлей показывал «ОБНОВИТЬ за 1» и «НИЧЕГО».
 * Заклинание — «Мозаика Стылой Межи» `BG35_MagicItem_755t`, «Refresh the
 * Tavern with Battlecry minions. They cost (1).» — чародейство тринкета,
 * бесплатное (тега `COST` нет), в руке каждый ход с 17-го.
 *
 * Дыр оказалось две, и обе закрыты здесь:
 *
 *  1. заклинание было НЕВИДИМО: ни статов, ни золота, ни миньона в тексте,
 *     разбор эффекта возвращал `null`. Теперь оно советуется телами —
 *     покупки по новой цене на остаток золота против покупок по карману
 *     сейчас (`discountRefreshRule`);
 *  2. цена «(1)» после него была НЕВИДИМА: игра пишет её тегом `COST`
 *     на кнопках `TB_BaconShop_DragBuy`, а не `BACON_REDUCE_BUY_COST`
 *     на миньонах (в партии ни одного). Теперь редьюсер читает цену
 *     с кнопки (`Minion.buyCost`), и после заклинания при двух золотых
 *     советник видит покупки по одному — как их и сделал игрок.
 */
describe('part35: «Мозаика Стылой Межи» — обновление витрины с ценой и живая цена покупки', () => {
  const MOSAIC = 'BG35_MagicItem_755t';
  let cards: CardIndex;
  /** Последнее состояние хода 19 до первой траты: золото 10, «Мозаика» уже в руке. */
  let decision19: GameState | null = null;
  /** Скриншот: ход 19 после подъёма — тир 5, золото 2/10, «Мозаика» в руке, витрина по три. */
  let shot19: GameState | null = null;
  /** Ход 17 сразу после первого розыгрыша «Мозаики» (18:05:10): витрина по одному. */
  let afterMosaic17: GameState | null = null;
  /** Ход 19 сразу после «Мозаики» (18:08:02): пять кличевых по одному при двух золотых. */
  let afterMosaic19: GameState | null = null;
  let end1: GameState;
  let end2: GameState;

  const hasMosaic = (s: GameState): boolean => s.handSpells.some((sp) => sp.cardId === MOSAIC);
  const pricedAtOne = (s: GameState): number => s.shop.filter((m) => m.buyCost === 1).length;

  beforeAll(() => {
    cards = loadCardIndex();
    const text = part35Segment(1);
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;
      if (s.turn === 17 && afterMosaic17 === null && s.shop.length >= 5 && pricedAtOne(s) >= 5) {
        afterMosaic17 = s;
      }
      if (s.turn !== 19) continue;
      if (
        s.goldSpent === 0 &&
        hasMosaic(s) &&
        s.shop.length >= 6 &&
        s.shop.every((m) => m.buyCost !== null)
      ) {
        decision19 = s;
      }
      if (shot19 === null && s.techLevel === 5 && s.gold === 2 && hasMosaic(s) && s.shop.length >= 6) {
        shot19 = s;
      }
      if (afterMosaic19 === null && s.techLevel === 5 && pricedAtOne(s) >= 5) afterMosaic19 = s;
    }
    end1 = reducer.snapshot();

    const text2 = part35Segment(2);
    const reducer2 = createReducer(readPlayers(text2));
    for (const event of readPowerEvents(text2)) reducer2.step(event);
    end2 = reducer2.snapshot();
  }, 900_000);

  const must = (s: GameState | null, what: string): GameState => {
    if (s === null) throw new Error(`не найдено состояние: ${what}`);
    return s;
  };

  it('сегмент 1 обрывается на ходу 19, сегмент 2 с дампа переподключения доигрывается до 5-го места', () => {
    expect(end1.turn).toBe(19);
    expect(end1.phase).toBe('tavern');
    expect(end1.hero?.cardId).toBe('TB_BaconShop_HERO_53');
    expect(end1.buildNumber).toBe(250339);
    expect(end1.playerBattleTag).toBe('AngryMem#2886');

    expect(end2.phase).toBe('gameOver');
    expect(end2.turn).toBe(26);
    expect(end2.finalPlace).toBe(5);
    expect(end2.hero?.cardId).toBe('TB_BaconShop_HERO_53');
    expect(end2.buildNumber).toBe(250339);
    expect(end2.playerBattleTag).toBe('AngryMem#2886');
  });

  it('«Мозаика» лежит в руке заклинанием без цены, а её текст — обновление витрины кличевыми по 1', () => {
    const s = must(shot19, 'скриншот хода 19');
    const mosaic = s.handSpells.find((sp) => sp.cardId === MOSAIC) as HandSpell;
    expect(mosaic.cost).toBe(0);
    expect(mosaic.unplayable).toBe(false);
    expect(cards.info(MOSAIC)?.text).toMatch(/Refresh[\s\S]*Tavern[\s\S]*Battlecry[\s\S]*minions\.\s*They cost \(1\)/);
    // Тринкет-источник взят в 18:05:00: чародейство даёт заклинание каждый ход.
    expect(cards.info('BG35_MagicItem_755')?.mechanics).toContain('BACON_SPELLCRAFT_ID');
  });

  /**
   * Дыра 2. Блок розыгрыша (18:05:10) пересоздаёт витрину: пять кличевых
   * миньонов новыми сущностями, у каждого кнопка `DragBuy` с `COST` 3 → 1
   * в конце блока; тега `BACON_REDUCE_BUY_COST` нет ни на одном.
   */
  it('после «Мозаики» витрина — кличевые по одному: цена с кнопки DragBuy, тега скидки на миньонах нет', () => {
    const s = must(afterMosaic17, 'ход 17 после «Мозаики»');
    expect(s.turn).toBe(17);
    expect(s.shop.length).toBeGreaterThanOrEqual(5);
    const priced = s.shop.filter((m) => m.buyCost === 1);
    expect(priced).toHaveLength(5);
    for (const m of priced) {
      expect(cards.info(m.cardId)?.mechanics).toContain('BATTLECRY');
      expect(m.tags['BACON_REDUCE_BUY_COST']).toBeUndefined();
      expect(buyCostOf(m)).toBe(1);
    }
    // Заклинание той же витрины (Boon of Beetles) — по своему тегу COST.
    expect(s.shopSpells.map((sp) => `${sp.cardId}:${String(sp.cost)}`)).toContain('BG28_603:1');
  });

  /**
   * Дыра 1, скриншот. Два золота при витрине по три — покупок ноль,
   * а после бесплатного обновления по одному — две: разница и есть
   * ценность заклинания. Обновление за 1 кнопкой рядом с ним не стоит.
   */
  it('скриншот хода 19: верхний совет — разыграть «Мозаику» (две покупки вместо нуля), а не «ОБНОВИТЬ за 1»', () => {
    const s = must(shot19, 'скриншот хода 19');
    expect([s.turn, s.techLevel, s.gold, s.goldTotal]).toEqual([19, 5, 2, 10]);
    expect(s.board).toHaveLength(7);
    expect(s.shop.every((m) => buyCostOf(m) === 3)).toBe(true);
    expect(buyRules(s, { cards })).toHaveLength(0);

    const advice = adviseTavern(s, { cards });
    const top = advice?.recommendations[0];
    expect(top?.action).toBe('play');
    expect(top?.spellCardId).toBe(MOSAIC);
    expect(top?.refreshesShop).toBe(true);
    expect(top?.refreshSpend).toBe(2);
    expect(top?.reason).toContain('обновление витрины кличевыми по 1');
    expect(top?.reason).toContain('на 2 золота покупок 2');
    expect(top?.reason).toContain('против 0 по карману сейчас');
    // Ценность — два тела по ожиданию кличевого пула тиров 1–5, без веса.
    const mosaic = s.handSpells.find((sp) => sp.cardId === MOSAIC) as HandSpell;
    const rule = discountRefreshRule(mosaic, s, { cards });
    expect(rule?.score).toBeGreaterThan(20);
    expect(advice?.recommendations.some((r) => r.action === 'reroll')).toBe(false);

    const plan = spendPlan(s, { cards });
    expect(plan?.steps[0]?.recommendation.spellCardId).toBe(MOSAIC);
    expect(plan?.steps[0]?.goldAfter).toBe(0);
    expect(plan?.truncated).toBe(true);
  });

  /**
   * Точка решения хода 19: золото 10, витрина с двумя драконами по 30 очков.
   * В СПИСКЕ заклинание молчит — оно отняло бы эти покупки, — а в ПЛАНЕ
   * встаёт после подъёма: «поднять за 8 → «Мозаика» на остаток 2». Это
   * дословно ход игрока: 18:07:48 подъём, 18:08:02 «Мозаика», 18:08:18
   * и 18:08:19 две покупки по одному.
   */
  it('ход 19, золото 10: в списке «Мозаика» молчит, план — поднять за 8 → «Мозаика» на остаток', () => {
    const s = must(decision19, 'точка решения хода 19');
    expect([s.turn, s.techLevel, s.gold, s.tavernUpgradeCost]).toEqual([19, 4, 10, 8]);
    expect(hasMosaic(s)).toBe(true);
    expect(spellRules(s, { cards }).some((r) => r.spellCardId === MOSAIC)).toBe(false);

    const plan = spendPlan(s, { cards });
    const steps = plan?.steps ?? [];
    expect(steps.map((st) => st.recommendation.action)).toEqual(['levelUp', 'play']);
    expect(steps[1]?.recommendation.spellCardId).toBe(MOSAIC);
    expect(steps[1]?.goldBefore).toBe(2);
    expect(steps[1]?.goldAfter).toBe(0);
    expect(plan?.truncated).toBe(true);
  });

  /**
   * После «Мозаики» на ходу 19 при двух золотых советник видит покупку
   * по одному — и говорит о скидке вслух. Прежде витрина числилась по три,
   * и совет был бы «НИЧЕГО».
   */
  it('после «Мозаики» на ходу 19 покупка по одному видна при двух золотых', () => {
    const s = must(afterMosaic19, 'ход 19 после «Мозаики»');
    expect(s.gold).toBe(2);
    expect(hasMosaic(s)).toBe(false);
    expect(pricedAtOne(s)).toBe(5);
    const buys = buyRules(s, { cards });
    expect(buys.length).toBeGreaterThan(0);
    expect(buys.every((b) => b.cost === 1)).toBe(true);
    expect(buys[0]?.reason).toContain('скидка — за 1 вместо 3');

    // Журнал: игрок так и сыграл — две покупки на ходу 19 после «Мозаики».
    const turn19 = end1.actions.filter((a) => a.turn === 19);
    const mosaicAt = turn19.findIndex((a) => a.type === 'play' && a.cardId === MOSAIC);
    expect(mosaicAt).toBeGreaterThanOrEqual(0);
    const buysAfter = turn19.slice(mosaicAt + 1).filter((a) => a.type === 'buy');
    expect(buysAfter.length).toBeGreaterThanOrEqual(2);
  });
  /**
   * Дыра 3, названная игроком той же партией: расчёты «сколько тел
   * по карману» делили золото на тройку из правил, а не считали живые цены.
   * После «Мозаики» витрина по одному, и два золота — это ДВЕ покупки,
   * а не ноль.
   */
  it('«сколько тел по карману» считается по живым ценам витрины', () => {
    const cheap = must(afterMosaic17, 'ход 17 после «Мозаики»');
    // Пять кличевых по одному: на два золота — двое, на пять — пятеро,
    // и больше витрины не купишь при любом золоте.
    expect(bodiesAffordable(cheap, 2)).toBe(2);
    expect(bodiesAffordable(cheap, 5)).toBeGreaterThanOrEqual(5);
    expect(bodiesAffordable(cheap, 99)).toBe(cheap.shop.length);

    // Та же партия, витрина по правилу игры: числа прежние.
    const normal = must(shot19, 'скриншот хода 19');
    expect(bodiesAffordable(normal, 2)).toBe(0);
    expect(bodiesAffordable(normal, 3)).toBe(1);
    expect(bodiesAffordable(normal, 7)).toBe(2);

    // Пустая витрина — это «цен не видно», а не «купить не на что»:
    // вопрос у зовущих про золото, и ответ там по правилу игры.
    expect(bodiesAffordable({ ...normal, shop: [] }, 7)).toBe(2);
  });
});
