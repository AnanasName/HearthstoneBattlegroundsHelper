import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  freezeRule,
  isEffectEngine,
  rerollRule,
  spellRules,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { CardsFreshness } from '../../src/live/freshness.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part27Game } from '../fixtures.js';
import { minion } from '../minions.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part27 — девятнадцатая партия с оверлеем (26.08.2026, пираты, 3-е место)
 * и первая на билде 250339. Три пункта обратной связи, и все три — про
 * состояние ПОСРЕДИ хода, после трат: точки решения (`readTavernTurns`)
 * таких состояний не видят, поэтому моменты ловятся условиями на само
 * состояние, как размечено в `part27.expected.json`.
 */
describe('part27: заморозка после покупки, цель провокации и обновление при нуле золота', () => {
  let cards: CardIndex;

  /** Ход 1, точка решения: золото 3, витрина полна. */
  let decision: GameState | null = null;
  /** Ход 1 после покупки Crackling Cyclone, ДО ручной заморозки игрока. */
  let afterBuy: GameState | null = null;
  /** Ход 3, точка решения: витрина после заморозки. */
  let nextTurn: GameState | null = null;
  /** Ход 7: золото 0, два Slimy Shield в руке. */
  let shields: GameState | null = null;
  /** Ход 19: золото 0, борд полон, витрина — два Risen Rider 6/1. */
  let zeroGold: GameState | null = null;
  let staleWarning: string | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part27Game();
    cards = loadCardIndex();
    const freshness = new CardsFreshness(cards);

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern' || s.hero === null) continue;

      const warning = freshness.update(s);
      if (warning !== null) staleWarning = warning;

      if (s.turn === 1 && s.goldSpent === 0 && s.shop.length > 0) decision = s;
      if (
        s.turn === 1 &&
        s.gold === 0 &&
        s.board.length === 1 &&
        !s.shop.some((m) => m.frozen)
      ) {
        afterBuy = s;
      }
      if (s.turn === 3 && s.goldSpent === 0 && s.shop.length > 0) nextTurn = s;
      if (s.turn === 7 && s.gold === 0 && s.handSpells.length === 2) shields ??= s;
      if (
        s.turn === 19 &&
        s.gold === 0 &&
        s.board.length === 7 &&
        s.shop.length === 2 &&
        s.shop.every((m) => m.attack === 6 && m.health === 1)
      ) {
        zeroGold ??= s;
      }
    }
    finalState = reducer.snapshot();
  }, 600_000);

  it('партия дочитывается до конца: 3-е место, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(3);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_36_SKIN_H');
    expect(finalState.buildNumber).toBe(250339);
  });

  it('новый билд, но снапшот его знает: предупреждение о свежести не сработало', () => {
    // Меньше трёх незнакомых карт в зонах советов — советы этой партии
    // слепыми не были, и разбирать их как советы имеет смысл.
    expect(staleWarning).toBeNull();
  });

  /**
   * Пункт 1 (скриншот хода 1): «снова перестало советовать заморозку
   * на ранних ходах».
   *
   * На точке решения план обещал заморозку вторым шагом; игрок сделал
   * первый (купил Crackling Cyclone — второго из двух равных миньонов),
   * и совет стал «НИЧЕГО». Цена заморозки считалась по СРЕДНЕЙ доживающей
   * карте, а её роняла дешёвка рядом с лучшей; в гипотетическом состоянии
   * плана дешёвка была соплеменником купленного и стоила больше.
   */
  it('пункт 1: на точке решения план обещает заморозку лассо вторым шагом', () => {
    expect(decision).not.toBeNull();
    if (decision === null) return;

    expect(decision.gold).toBe(3);
    expect(decision.shop.map((m) => m.cardId)).toEqual(['BG25_001', 'BGS_119', 'BG28_300']);
    expect(decision.shopSpells.map((s) => s.cardId)).toEqual(['BG28_512']);

    const plan = spendPlan(decision, { cards });
    expect(plan.steps.map((s) => s.recommendation.action)).toEqual(['buy', 'freeze']);
    expect(plan.steps[1]?.recommendation.spellCardId).toBe('BG28_512');
  });

  it('пункт 1: после покупки другого из двух равных миньонов заморозка остаётся', () => {
    expect(afterBuy).not.toBeNull();
    if (afterBuy === null) return;

    expect(afterBuy.board.map((m) => m.cardId)).toEqual(['BGS_119']);
    expect(afterBuy.shop.map((m) => m.cardId)).toEqual(['BG25_001', 'BG28_300']);

    const freeze = freezeRule(afterBuy, { cards });
    expect(freeze?.action).toBe('freeze');
    expect(freeze?.spellCardId).toBe('BG28_512');

    // И первой строкой списка, и планом: другого действия при нуле золота нет.
    const advice = adviseTavern(afterBuy, { cards });
    expect(advice?.recommendations[0]?.action).toBe('freeze');
    expect(spendPlan(afterBuy, { cards }).steps.map((s) => s.recommendation.action)).toEqual([
      'freeze',
    ]);
  });

  it('пункт 1: замороженная витрина дозаполняется свежей картой в купленном слоте', () => {
    expect(nextTurn).not.toBeNull();
    if (nextTurn === null) return;

    // Доживающие остались, а на месте купленного Crackling Cyclone — новый
    // Molten Rock: цена заморозки не может считать пустой слот потерей.
    expect(nextTurn.shop.map((m) => m.cardId)).toEqual(['BG25_001', 'BG28_300', 'BGS_127']);
    expect(nextTurn.shopSpells.map((s) => s.cardId)).toEqual(['BG28_512']);
  });

  /**
   * Пункт 2 (скриншот хода 7): Slimy Shield (+1/+1 и провокация)
   * советовался на Oozeling Gladiator 3/3 — отработавший генератор,
   * которого игрок собирался продать, — при Molten Rock 4/4 на борде.
   * Molten Rock числился движком словом «After», а его триггер тавернный.
   */
  it('пункт 2: тавернный триггер — не движок, боевой — движок', () => {
    // Molten Rock: «After you play an Elemental, gain +{1} Health».
    expect(isEffectEngine(minion(1, { cardId: 'BGS_127' }), cards)).toBe(false);
    // Deathstrider — первоисточник правила (part15): «After a friendly
    // Rally minion attacks, trigger your left-most Deathrattle».
    expect(isEffectEngine(minion(2, { cardId: 'BG36_208' }), cards)).toBe(true);
    // Аура на чужих остаётся движком без разбора текста.
    expect(isEffectEngine(minion(3, { cardId: 'BG_LOE_077' }), cards)).toBe(true);
    // Обновление витрины — событие таверны, даже с двойным тегом разметки
    // (Timewarped Kil'jaeden: «whenever it is <b><b>Refreshed</b>.</b>»).
    expect(isEffectEngine(minion(4, { cardId: 'BG34_Giant_313' }), cards)).toBe(false);
  });

  it('пункт 2: по пулу большинство триггеров — тавернные', () => {
    const engineHead = DEFAULT_TAVERN_RULES.engineTextWords.map((w) => new RegExp(w, 'i'));
    const selfTrigger = DEFAULT_TAVERN_RULES.selfTriggerWords.map((w) => new RegExp(w, 'i'));
    const seen = new Set<string>();
    let withHead = 0;
    let combat = 0;
    for (let tier = 1; tier <= 6; tier++) {
      for (const info of cards.poolOfTier(tier)) {
        if (seen.has(info.id)) continue;
        seen.add(info.id);
        const text = info.text ?? '';
        if (info.mechanics.includes('AURA')) continue;
        if (selfTrigger.some((r) => r.test(text))) continue;
        if (!engineHead.some((r) => r.test(text))) continue;
        withHead += 1;
        if (isEffectEngine(minion(1, { cardId: info.id }), cards)) combat += 1;
      }
    }
    // 129 голов триггера; движками остаются 46 — в том числе слушатели
    // заклинаний («Whenever you cast a Tavern spell»: Timecap'n Hooktail,
    // Charging Czarina) и добычи в руку (Timewarped Peggy): и то и другое
    // случается в бою через Rally, и симулятор это моделирует.
    expect(withHead).toBe(129);
    expect(combat).toBe(46);
  });

  it('пункт 2: Slimy Shield целится в крупнейшее тело, а не в отработавший генератор', () => {
    expect(shields).not.toBeNull();
    if (shields === null) return;

    expect(shields.board.map((m) => m.cardId)).toEqual([
      'BGS_127',
      'BGS_119',
      'BG26_135',
      'BG27_002',
      'BG25_001',
    ]);
    expect(shields.handSpells.map((s) => s.cardId)).toEqual(['BG27_002t', 'BG27_002t']);

    const plays = spellRules(shields, { cards });
    expect(plays).toHaveLength(2);
    for (const play of plays) {
      expect(play.targetMinion?.cardId).toBe('BGS_127');
      expect(play.reason).toContain('цель — Molten Rock');
      expect(play.reason).not.toContain('Oozeling');
    }
  });

  /**
   * Пункт 3 (скриншот хода 19): «рекомендует обновить, хотя даже, если
   * я обновлю, то не смогу купить существ без продажи». Золото 0, борд
   * полон, обновление бесплатно — и причина «покупать нечего» обещала
   * покупку, которой быть не могло. Обновление, после которого не на что
   * купить, годится только под заморозку, и цель обязана быть названа.
   */
  it('пункт 3: обновление при нуле золота называет цель заморозки', () => {
    expect(zeroGold).not.toBeNull();
    if (zeroGold === null) return;

    expect(zeroGold.rerollCost).toBe(0);
    expect(zeroGold.board).toHaveLength(7);
    // Две пары: Bigwig Bandit (тир 4) на борде и в руке, Dual-Wield Corsair
    // (тир 5) дважды на борде. Называется старшая по тиру — обе витрина
    // пятого тира предложить может.
    expect(zeroGold.board.some((m) => m.cardId === 'BG33_822')).toBe(true);
    expect(zeroGold.hand.some((m) => m.cardId === 'BG33_822')).toBe(true);
    expect(zeroGold.board.filter((m) => m.cardId === 'BG31_824')).toHaveLength(2);

    const reroll = rerollRule(zeroGold, { cards });
    expect(reroll?.action).toBe('reroll');
    expect(reroll?.reason).toContain('купить нечего и после обновления');
    expect(reroll?.reason).toContain('искать под заморозку третью копию Dual-Wield Corsair');
    expect(reroll?.reason).not.toContain('покупать нечего');
  });

  it('пункт 3: без пары и на полном борде обновление при нуле золота молчит', () => {
    expect(zeroGold).not.toBeNull();
    if (zeroGold === null) return;

    // Рука без Bigwig Bandit, второй Dual-Wield Corsair — золотой: пар нет.
    const corsairs = zeroGold.board.filter((m) => m.cardId === 'BG31_824');
    const lonely: GameState = {
      ...zeroGold,
      hand: zeroGold.hand.filter((m) => m.cardId !== 'BG33_822'),
      board: zeroGold.board.map((m) =>
        m.entityId === corsairs[1]?.entityId ? { ...m, golden: true } : m,
      ),
    };

    expect(rerollRule(lonely, { cards })).toBeNull();
    const advice = adviseTavern(lonely, { cards });
    expect(advice?.recommendations.some((r) => r.action === 'reroll')).toBe(false);
  });

  it('пункт 3: на неполном борде цель — соплеменник собираемого племени', () => {
    expect(zeroGold).not.toBeNull();
    if (zeroGold === null) return;

    // Убираем одного корсара и Bigwig из руки: пар нет, место есть, пиратов
    // на борде шесть — обновление ищет пирата пятого тира под заморозку.
    const corsairs = zeroGold.board.filter((m) => m.cardId === 'BG31_824');
    const roomy: GameState = {
      ...zeroGold,
      hand: zeroGold.hand.filter((m) => m.cardId !== 'BG33_822'),
      board: zeroGold.board.filter((m) => m.entityId !== corsairs[1]?.entityId),
    };

    const reroll = rerollRule(roomy, { cards });
    expect(reroll?.reason).toContain('искать под заморозку соплеменника PIRATE тира 5');
    // Та же цель — в СТРОКЕ действия: причину оверлей не показывает (part37).
    expect(reroll?.searchGoal).toBe('соплеменника PIRATE тира 5');
  });
});
