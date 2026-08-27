import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  heroPowerRule,
  rerollRule,
  shopSpellRules,
  spellEffect,
  spellRules,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part30Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part30 — двадцать вторая партия с оверлеем (27.08.2026, 19:55–20:23,
 * Крысиный король, 3-е место), четвёртая на билде 250339. Четыре пункта
 * обратной связи по четырём скриншотам.
 *
 * Три момента из четырёх — состояния ПОСРЕДИ хода, после трат: точки
 * решения их не видят, поэтому тест ловит их условиями на состояние,
 * как в part27–part29.
 */
describe('part30: сила-Discover, заклинание по витрине, золото следующего хода, сток сгорающего золота', () => {
  let cards: CardIndex;
  /** Скриншот 1 — ход 1, точка решения: золото 3/3, витрина 3 миньона + банан. */
  let shot1: GameState | null = null;
  /** Ход 7, точка решения: золото 6/6, Them Apples в руке. */
  let shot2a: GameState | null = null;
  /** Скриншот 2 — ход 7 посреди: золото 0/6, Gem Rat куплен, Them Apples в руке. */
  let shot2b: GameState | null = null;
  /** Скриншот 3 — ход 9 посреди: золото 2/7, Careful Investment в витрине. */
  let shot3: GameState | null = null;
  /** Скриншот 4 — ход 19 посреди: золото 1/10, борд полон, рука — одна Предвестница. */
  let shot4: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part30Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern' || s.hero === null) continue;

      // Точка решения хода 1 — ПОСЛЕДНЕЕ состояние до первой траты:
      // витрина наполняется не мгновенно, поэтому переприсваивание.
      if (s.turn === 1 && s.gold === 3 && s.shop.length === 3 && s.shopSpells.length === 1) {
        shot1 = s;
      }
      if (
        s.turn === 7 &&
        s.gold === 6 &&
        s.shop.length === 4 &&
        s.handSpells.some((x) => x.cardId === 'BG28_966')
      ) {
        shot2a ??= s;
      }
      if (
        s.turn === 7 &&
        s.gold === 0 &&
        s.board.some((m) => m.cardId === 'BG31_326') &&
        s.handSpells.some((x) => x.cardId === 'BG28_966')
      ) {
        shot2b ??= s;
      }
      if (
        s.turn === 9 &&
        s.gold === 2 &&
        s.shopSpells.some((x) => x.cardId === 'BG28_800') &&
        s.handSpells.some((x) => x.cardId === 'BG31_893')
      ) {
        shot3 ??= s;
      }
      if (
        s.turn === 19 &&
        s.gold === 1 &&
        s.board.length === 7 &&
        s.hand.length === 1 &&
        s.shop.length === 2
      ) {
        shot4 ??= s;
      }
    }
    finalState = reducer.snapshot();
  }, 900_000);

  it('партия дочитывается до конца: 3-е место, Крысиный король, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(3);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_12');
    expect(finalState.buildNumber).toBe(250339);
  });

  /**
   * Пункт 1 (скриншот хода 1): «вместо нажатия способности и применения
   * заклинания мне советует просто купить существо».
   *
   * Сила Крысиного короля — вариант на каждый ход («King of Mechs»
   * `TB_BaconShop_HP_041b`, COST=2, «Discover a Mech. Swaps type each
   * turn»). Слова «minion» в тексте нет — миньона обещает ПЛЕМЯ, как
   * у «Discover a Naga» из part26, и прежний `heroPowerRule` молчал.
   */
  it('пункт 1: сила «Discover a Mech» видна состоянию с живой ценой', () => {
    expect(shot1).not.toBeNull();
    const s = shot1 as GameState;
    expect(s.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_041b');
    expect(s.hero?.heroPowerCost).toBe(2);
    expect(s.hero?.heroPowerUsedThisTurn).toBe(false);
  });

  it('пункт 1: сила советуется и стоит выше покупки', () => {
    const s = shot1 as GameState;
    const rec = heroPowerRule(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec).not.toBeNull();
    expect(rec?.cost).toBe(2);
    // Discover — ВЫБОР из предложенного, а не случайная карта: ожидание
    // лучшего из трёх. Мехов первого тира в пуле два (Lullabot 5.0,
    // Cord Puller 7.5) — предложение почти наверняка содержит обоих,
    // и ожидание равно лучшему.
    expect(rec?.score).toBeCloseTo(7.5, 1);
    expect(rec?.reason).toContain('MECH');

    // Верхняя строка совета — сила, а не «просто купить существо»:
    // лучшая покупка (Tusked Camper) стоит 7.0. В логе игрок сделал ровно
    // это: нажал силу (19:56:49), разыграл найденного Cord Puller
    // (19:56:55) и купил на него банан за 1 (19:56:58).
    const advice = adviseTavern(s, { cards });
    expect(advice?.recommendations[0]?.action).toBe('heroPower');
  });

  /**
   * Пункт 2 (скриншот хода 7): «мне рекомендуют разыграть заклинание,
   * которое применяется на таверну, а не на существо».
   *
   * Them Apples `BG28_966` — «Give minions in the Tavern +{0}/+{1}»:
   * в логе блок PLAY идёт с `Target=0`, а энчанты ложатся на миньонов
   * `player=10` (витрина). Прежний разбор считал статы своему борду
   * и называл целью крупнейшего своего.
   */
  it('пункт 2: Them Apples бьёт по витрине и цели не называет', () => {
    const effect = spellEffect('BG28_966', [1, 2], cards);
    expect(effect?.buffsShop).toBe(true);
    expect(effect?.stats).toBe(3);

    expect(shot2a).not.toBeNull();
    const s = shot2a as GameState;
    const rec = spellRules(s, { cards }, DEFAULT_TAVERN_RULES).find(
      (r) => r.spellCardId === 'BG28_966',
    );
    expect(rec).toBeDefined();
    // Цель НЕ называется: игра раздаёт статы витрине сама.
    expect(rec?.targetMinion).toBeUndefined();
    expect(rec?.reason).toContain('витрин');
    expect(rec?.reason).not.toContain('перед боем');
    // Статы достаются только купленным: +1/+2 на миньона, покупок на шесть
    // золотых — две. 3 × 2 × 0.5 = 3.0.
    expect(rec?.score).toBeCloseTo(3.0, 5);
  });

  it('пункт 2: при нуле золота витринный бафф молчит — покупок не будет', () => {
    expect(shot2b).not.toBeNull();
    const s = shot2b as GameState;
    const recs = spellRules(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(recs.find((r) => r.spellCardId === 'BG28_966')).toBeUndefined();
  });

  /**
   * Пункт 3 (скриншот хода 9): «мне предлагает сделать ход, на который
   * у меня нет денег» — план обещал «КУПИТЬ Careful Investment за 1 →
   * ТЁМНЫЙ ДАР за 3» при двух золотых.
   *
   * Careful Investment `BG28_800` — «Gain 2 Gold NEXT TURN»: золото
   * приходит следующим ходом, а `grantsGold` доносил его до следующего
   * шага плана как живое, и дар за 3 становился «по карману».
   */
  it('пункт 3: золото «next turn» не считается золотом этого хода', () => {
    const effect = spellEffect('BG28_800', [], cards);
    expect(effect).not.toBeNull();
    expect(effect?.gold).toBe(0);
    expect(effect?.goldNextTurn).toBe(2);

    expect(shot3).not.toBeNull();
    const s = shot3 as GameState;
    const rec = shopSpellRules(s, { cards }, DEFAULT_TAVERN_RULES).find(
      (r) => r.spellCardId === 'BG28_800',
    );
    expect(rec).toBeDefined();
    // Покупка выгодна (чистыми +1), но плану она золота НЕ приносит.
    expect(rec?.grantsGold).toBeUndefined();
    expect(rec?.reason).toMatch(/следующ/i);
  });

  it('пункт 3: план не строит шагов, на которые нет золота', () => {
    const s = shot3 as GameState;
    const plan = spendPlan(s, { cards });
    // Дар за 3 при двух золотых в план не входит — золото инвестиции
    // придёт только следующим ходом.
    expect(plan.steps.some((st) => st.recommendation.action === 'darkGift')).toBe(false);
    for (const st of plan.steps) {
      expect(st.goldBefore).toBeGreaterThanOrEqual(st.recommendation.cost);
    }
  });

  /**
   * Той же правкой закрыт Gem Day `BG31_893` из того же плана: «Choose One —
   * Your Blood Gems give an extra +1 Attack this game; or +1 Health».
   * Ветвей-карт в снапшоте нет, текст родителя складывал ОБЕ ветви
   * (+2 статов) и совет называл целью своего миньона — а эффект живёт
   * на будущих кровавых самоцветах, у которых цены у нас нет (part28).
   */
  it('Gem Day: Blood Gems не оцениваются — заклинание честно молчит', () => {
    expect(spellEffect('BG31_893', [1], cards)).toBeNull();
    const s = shot3 as GameState;
    const recs = spellRules(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(recs.find((r) => r.spellCardId === 'BG31_893')).toBeUndefined();
  });

  /**
   * Пункт 4 (скриншот хода 19): «предлагает сделать ничего, хотя я могу
   * на крайний случай потратить золото на обновление — это позволит
   * активировать эффекты моих карт, а это золото я потеряю в любом случае».
   *
   * Золото 1/10, борд полон, в витрине ничего дешевле трёх — золотой
   * сгорает. На борде два пирата, которых кормит сама трата: Dual-Wield
   * Corsair («Whenever you spend 5 Gold…») и Enterprising Escapee
   * («After you spend {2} Gold…»). Игрок потратил последний золотой
   * на обновление сам — лог показывает reroll сразу после этого момента.
   */
  it('пункт 4: сгорающее золото уходит в обновление под триггеры трат', () => {
    expect(shot4).not.toBeNull();
    const s = shot4 as GameState;
    expect(s.rerollCost).toBe(1);
    expect(s.board.some((m) => m.cardId === 'BG31_824')).toBe(true);
    expect(s.board.some((m) => m.cardId === 'BG36_523')).toBe(true);

    const rec = rerollRule(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec).not.toBeNull();
    expect(rec?.cost).toBe(1);
    expect(rec?.reason).toContain('сгор');
    expect(rec?.reason).toContain('Dual-Wield Corsair');
    expect(rec?.reason).toContain('Enterprising Escapee');

    // И это верхняя строка совета — вместо прежнего «НИЧЕГО».
    const advice = adviseTavern(s, { cards });
    expect(advice?.recommendations[0]?.action).toBe('reroll');
  });
});
