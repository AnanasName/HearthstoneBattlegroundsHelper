import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  trinketAdvice,
  buyRules,
  heroPowerKeywordRule,
  minionValue,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part32Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part32 — двадцать четвёртая партия с оверлеем (27–28.08.2026, 23:48–00:21,
 * Король-лич, нежить, 1-е место), шестая на билде 250339. Два пункта
 * по двум скриншотам, оба — состояния ПОСРЕДИ хода, поэтому моменты
 * ловятся условиями на состояние, а не точками решения.
 */
describe('part32: бесплатная сила «даёт перерождение», хрип-призыв с переносом строки', () => {
  let cards: CardIndex;
  /** Скриншот 1 — ход 1, золото 0/3, на борде купленный Glim Guardian, сила не нажата. */
  let shot1: GameState | null = null;
  /** Ход 1 сразу после нажатия силы (23:49:36). */
  let pressed1: GameState | null = null;
  /** Скриншот 2 — ход 11, золото 4/8 (тринкет за 4), борд из четырёх, сила не нажата. */
  let shot2: GameState | null = null;
  /** Ход 13 до нажатия: на борде Mummifier — первое из шести нажатий на него. */
  let turn13: GameState | null = null;
  /** Ход 17: предложение тринкетов ЦЕЛИКОМ, все четыре варианта видны. */
  let trinkets17: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part32Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern' || s.hero === null) continue;
      const used = s.hero.heroPowerUsedThisTurn;

      if (s.turn === 1 && s.gold === 0 && s.board.length === 1 && s.shop.length === 2) {
        if (!used && shot1 === null) shot1 = s;
        if (used && pressed1 === null) pressed1 = s;
      }
      if (s.turn === 11 && s.gold === 4 && s.board.length === 4 && s.shop.length === 4 && !used) {
        shot2 = s;
      }
      // Последнее состояние хода 13 до нажатия: флаг поднимается строкой
      // BLOCK_START, и все снимки после неё уже с ним.
      if (s.turn === 13 && !used && s.board.some((m) => m.cardId === 'BG28_309')) {
        turn13 = s;
      }
      // Второе предложение тринкетов: варианты приходят по одному, и полным
      // оно бывает ровно до выбора — ловим первое состояние со всеми четырьмя.
      if (s.turn === 17 && s.trinketOffer.length === 4 && trinkets17 === null) {
        trinkets17 = s;
      }
    }
    finalState = reducer.snapshot();
  }, 900_000);

  it('партия дочитывается до конца: 1-е место, Король-лич, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(1);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_22');
    expect(finalState.buildNumber).toBe(250339);
  });

  it('сила читается из лога: активна, без цены, нажата на всех 16 ходах таверны', () => {
    expect(finalState.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_024');
    expect(finalState.hero?.heroPowerHasActivate).toBe(true);
    expect(finalState.hero?.heroPowerCost).toBeNull();
    const presses = finalState.actions.filter((a) => a.type === 'heroPower');
    expect(presses).toHaveLength(16);
    expect(new Set(presses.map((a) => a.turn)).size).toBe(16);
  });

  /**
   * Пункт 1: «на 1 скриншоте мне не предлагает сыграть силу героя, хотя
   * её точно стоит сыграть». Золото 0/3, Glim Guardian 1/4 на борде,
   * совет — «НИЧЕГО». Игрок нажал силу на него через полминуты (23:49:36).
   */
  it('пункт 1: на скриншоте сила советуется верхней строкой, цель — Glim Guardian', () => {
    expect(shot1).not.toBeNull();
    const s = shot1 as GameState;
    expect(s.hero?.heroPowerUsedThisTurn).toBe(false);

    const rec = heroPowerKeywordRule(s, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec).not.toBeNull();
    expect(rec?.targetMinion?.cardId).toBe('BG29_888');
    expect(rec?.grantsKeyword).toBe('reborn');
    expect(rec?.reason).toContain('Reborn Rites бесплатна');

    const advice = adviseTavern(s, { cards });
    expect(advice?.recommendations[0]?.action).toBe('heroPower');
    const plan = spendPlan(s, { cards });
    expect(plan.steps.map((st) => st.recommendation.action)).toEqual(['heroPower']);
    expect(plan.steps[0]?.stateAfter.board[0]?.reborn).toBe(true);
  });

  it('пункт 1: после нажатия сила молчит до следующего хода', () => {
    expect(pressed1).not.toBeNull();
    const s = pressed1 as GameState;
    expect(s.hero?.heroPowerUsedThisTurn).toBe(true);
    expect(heroPowerKeywordRule(s, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();
    // На следующем ходу таверны флаг сброшен — сила советуется снова.
    expect(shot2?.hero?.heroPowerUsedThisTurn).toBe(false);
  });

  /**
   * Пункт 2: «не понимаю, почему Gem Rat выбран как лучшая покупка».
   *
   * Gem Rat 4/4 (тир 3) стоил 10.0 — шесть очков тира и четыре статов,
   * текст («get a Gem Day») без цены. Harmless Bonehead 5/1 стоил 9.5:
   * тир 2.0, статы 3.0, трое своих нежити 4.5 — и НОЛЬ за хрип, потому
   * что «Deathrattle: Summon⏎two 1/1 Skeletons» в снапшоте переносит
   * строку после «Summon», а шаблон ждал пробел. По бою Bonehead 100%
   * против Gem Rat 97%, игрок купил Bonehead.
   */
  it('пункт 2: хрип-призыв Bonehead читается, и он обходит Gem Rat', () => {
    expect(shot2).not.toBeNull();
    const s = shot2 as GameState;
    expect(s.shop.map((m) => m.cardId)).toContain('BG28_300');
    expect(s.shop.map((m) => m.cardId)).toContain('BG31_326');

    const bonehead = s.shop.find((m) => m.cardId === 'BG28_300');
    const rat = s.shop.find((m) => m.cardId === 'BG31_326');
    if (bonehead === undefined || rat === undefined) throw new Error('витрина без пары');
    const bv = minionValue(bonehead, s, { cards });
    expect(bv.battle).toBe(DEFAULT_TAVERN_RULES.value.battleEffect);
    expect(bv.total).toBeCloseTo(12.0, 1);
    expect(minionValue(rat, s, { cards }).total).toBeCloseTo(10.0, 1);

    // `buyRules` отдаёт советы в порядке витрины, ранжирует список советник.
    const byScore = [...buyRules(s, { cards })].sort((a, b) => b.score - a.score);
    expect(byScore[0]?.minion?.cardId).toBe('BG28_300');
    expect(byScore[1]?.minion?.cardId).toBe('BG31_326');
    const advice = adviseTavern(s, { cards });
    const top = advice?.recommendations.find((r) => r.action === 'buy');
    expect(top?.minion?.cardId).toBe('BG28_300');
    const plan = spendPlan(s, { cards });
    expect(plan.steps[0]?.recommendation.minion?.cardId).toBe('BG28_300');
  });

  it('скриншот 2: золото 4/8 — четыре ушли на тринкет Baleful Incense', () => {
    const s = shot2 as GameState;
    // Тринкет куплен в 23:54:55: RESOURCES_USED 0 → 4 без блока PLAY,
    // на сущности тринкета в SETASIDE тег COST 0 → 4.
    expect(s.gold).toBe(4);
    expect(s.goldTotal).toBe(8);
    expect(s.trinketOffer).toHaveLength(0);
  });

  /**
   * Цель силы на ходах 11 и 13 — где правило и игрок расходятся
   * и сходятся. Ход 11: правило называет Friendly Geist 10/3 (хрип, атака
   * 10), игрок дал перерождение золотому Deathswarmer 6/8 без хрипа —
   * записано как открытый вопрос. Ход 13: Mummifier («Deathrattle: Give
   * a different friendly Undead Reborn») — цепочка, и игрок жал на него
   * шесть ходов подряд.
   */
  it('цель: на ходу 11 — Friendly Geist (хрип, атака), на ходу 13 — Mummifier (цепочка)', () => {
    const rec11 = heroPowerKeywordRule(shot2 as GameState, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec11?.targetMinion?.cardId).toBe('BG32_880');
    expect(rec11?.reason).toContain('хрип сработает дважды');

    expect(turn13).not.toBeNull();
    const rec13 = heroPowerKeywordRule(turn13 as GameState, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec13?.targetMinion?.cardId).toBe('BG28_309');
    expect(rec13?.reason).toContain('цепочка');
  });
  it('цена тринкета читается из лога и ВНУТРИ одного предложения разная', () => {
    // Тег COST на сущности варианта. Это не формальность: на ходу 17
    // при десяти золотых четыре варианта стоят 4, 5, 5 и 2 — то есть
    // выбор тринкета решает и то, останется ли золото на покупку.
    expect(trinkets17).not.toBeNull();
    const s = trinkets17 as GameState;
    expect(s.gold).toBe(10);
    expect(s.trinketOffer.map((t) => t.cost)).toEqual([4, 5, 5, 2]);

    // Совет цену НАЗЫВАЕТ (в ранжирование она не входит — веса у неё нет).
    const advice = trinketAdvice(s, { cards });
    expect(advice).toHaveLength(4);
    const cheapest = advice.find((a) => a.offer.cardId === 'BG30_MagicItem_420t');
    expect(cheapest?.reason).toContain('2 золота, останется 8');
  });
});
