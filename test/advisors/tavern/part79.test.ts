import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import type { GameState } from '../../../src/state/types.js';
import { frameAt, parseClock, sliceLogByClock } from '../../../src/ui/logSlice.js';
import { part79Game } from '../../fixtures.js';

const PRISONGUARD = 'BG36_345';
const BANANA = 'BG28_897';
const WRATH_WEAVER = 'BGS_004';

/**
 * part79 — Patchwerk (25.09.2026), 4-е место. Фактура партии — в `test/fixtures.ts`.
 */
describe('part79: кадры партии', () => {
  let cards: CardIndex;
  let text: string;

  beforeAll(() => {
    cards = loadCardIndex();
    text = part79Game();
  }, 120_000);

  const frame = (clock: string): GameState => {
    const at = parseClock(clock);
    if (at === null) throw new Error(`не часы: ${clock}`);
    const slice = sliceLogByClock(text, at);
    if (slice === null || !slice.inGame) throw new Error(`кадр ${clock} не в партии`);
    return frameAt(slice).state;
  };

  /**
   * Кадр `data/screenshots/part79/21-19.png`, ход 7 (ход таверны 4),
   * после подъёма в 21:19:24: золото 1, на борде Wrath Weaver 6/8
   * и Suspicious Prisonguard 3/3 («Activate ({2}): Give another minion
   * +{0}/+{1}», scriptData [3, 3, 1], INTERACTABLE_OBJECT_COST 1),
   * в витрине Tavern Dish Banana за 1 (+2/+2). Жалоба игрока: «рекомендует
   * применить банан, хотя активация, которую я имею, даёт больше статов».
   *
   * Совет был «КУПИТЬ Tavern Dish Banana → на Wrath Weaver» (2.0), и
   * активации в списке не было вовсе: `activationRules` вычитала цену
   * нажатия в очки (6 × 0.5 − 1 × 3 = 0) и гасила совет с нулём, а покупка
   * заклинания-усиления цену не вычитает — её считает план (D151).
   * Игрок нажал активацию в 21:19:33 (game.log:24561): Wrath Weaver
   * 6/8 → 9/11 (game.log:24582–24583) за один золотой (24563).
   */
  describe('21:19:30 — активация Prisonguard против банана за тот же золотой', () => {
    it('кадр воспроизводится: Weaver 6/8, Prisonguard 3/3 с ценой 1, банан, золото 1', () => {
      const state = frame('21:19:30');
      expect(state.gold).toBe(1);
      expect(state.board.map((m) => [m.cardId, m.attack, m.health])).toEqual([
        [WRATH_WEAVER, 6, 8],
        [PRISONGUARD, 3, 3],
      ]);
      const guard = state.board[1];
      expect(guard?.tags['INTERACTABLE_OBJECT_COST']).toBe(1);
      expect(guard?.scriptData.slice(0, 2)).toEqual([3, 3]);
      expect(state.shopSpells.map((s) => [s.cardId, s.cost])).toEqual([[BANANA, 1]]);
    });

    it('активация советуется выше банана и целит в Wrath Weaver', () => {
      const state = frame('21:19:30');
      const recs = adviseTavern(state, { cards })?.recommendations ?? [];
      const activate = recs.find((r) => r.action === 'activate' && r.minion?.cardId === PRISONGUARD);
      const banana = recs.find((r) => r.spellCardId === BANANA);
      expect(activate).toBeDefined();
      expect(activate?.targetMinion?.cardId).toBe(WRATH_WEAVER);
      expect(banana).toBeDefined();
      expect(activate?.score ?? 0).toBeGreaterThan(banana?.score ?? 0);
      expect(recs[0]).toBe(activate);
    });

    it('план тратит золотой на активацию, а не на банан', () => {
      const state = frame('21:19:30');
      const plan = spendPlan(state, { cards });
      expect(plan.steps.map((s) => s.recommendation.action)).toEqual(['activate']);
    });
  });

  /**
   * Та же развилка в начале хода 7 (золото 6, тир 2): план был «ПОДНЯТЬ
   * ТАВЕРНУ за 5 → КУПИТЬ Tavern Dish Banana». Игрок поднял и нажал
   * активацию.
   */
  it('21:19:20 — точка решения хода 7: подъём, затем активация', () => {
    const state = frame('21:19:20');
    expect(state.gold).toBe(6);
    const plan = spendPlan(state, { cards });
    expect(plan.steps.map((s) => s.recommendation.action)).toEqual(['levelUp', 'activate']);
  });
});
