import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, spellEffect, weakestOwn } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { endOfTurnAuraGains, withEndOfTurnAuras } from '../../src/advisors/battle/endOfTurn.js';
import { toBattleInfo, withPlayerBoard } from '../../src/advisors/battle/mapper.js';
import { sharedBattleSimulator } from '../../src/advisors/battle/simulator.js';
import { battleQuestion } from '../../src/advisors/position/advisor.js';
import { withSeededRandom } from '../../src/advisors/position/rng.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import { recommendationLine } from '../../src/ui/format.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { part19Game } from '../fixtures.js';

/**
 * part19 — одиннадцатая партия с оверлеем (16–17.08.2026, Nightmare Lord
 * Xavius, демоны, 1-е место). Четыре пункта обратной связи по четырём
 * скриншотам: пропавшая после подъёма заморозка, модальное заклинание
 * без подсказки, ралли вторым номером расстановки, продажа Бранна.
 *
 * Контрольные значения — `part19.expected.json`.
 */
describe('part19: заморозка после подъёма, ветви Choose One, ралли, аура', () => {
  let cards: CardIndex;

  let turn3Decision: GameState | null = null;
  let turn3AfterUpgrade: GameState | null = null;
  let turn7Flag: GameState | null = null;
  let turn9: GameState | null = null;
  let turn27: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part19Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const { content } = event.line;
      if (
        !content.includes('ZONE') &&
        !content.includes('RESOURCES') &&
        !content.includes('TECH_LEVEL') &&
        !content.includes('COST')
      ) {
        continue;
      }
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;

      // Ход 3, точка решения: 4 золота, витрина из трёх, лассо в ней же.
      if (s.turn === 3 && s.goldSpent === 0 && s.shop.length === 3) turn3Decision = s;
      // Ход 3 сразу после подъёма — момент скриншота: тир 2, золото кончилось,
      // витрина ещё та же и ещё не заморожена (игрок заморозил её сам).
      if (turn3AfterUpgrade === null && s.turn === 3 && s.techLevel === 2 && s.gold === 0) {
        turn3AfterUpgrade = s;
      }
      // Ход 7: Флаг Альянса куплен и лежит в руке — модальный выбор впереди.
      if (s.turn === 7 && s.handSpells.some((x) => x.cardId === 'BG31_880')) turn7Flag = s;
      // Ход 9: борд из четырёх, золото потрачено на подъём до 4 тира.
      if (s.turn === 9 && s.gold === 0 && s.techLevel === 4 && s.board.length === 4) turn9 = s;
      // Ход 27: полный борд с Бранном, золото нетронуто.
      if (s.turn === 27 && s.gold === 10 && s.board.length === 7) turn27 = s;
    }
    finalState = reducer.snapshot();
  }, 240_000);

  it('партия дочитывается до конца: 1-е место, билд из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(1);
    expect(finalState.hero?.cardId).toBe('BG36_HERO_105');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('ход 3: подъём таверны не отменяет заморозку ради заклинания (пункт 1)', () => {
    // Ходом раньше план советовал заморозить Enchanted Lasso, игрок так
    // и сделал. На ходу 3 он поднял таверну — и совет исчез, хотя лассо
    // на месте, денег на него по-прежнему нет, а заморозку каждый ход надо
    // продлевать заново.
    expect(turn3Decision).not.toBeNull();
    expect(turn3AfterUpgrade).not.toBeNull();
    if (turn3Decision === null || turn3AfterUpgrade === null) return;

    expect(turn3Decision.shopSpells.map((s) => s.cardId)).toContain('BG28_512');
    expect(turn3Decision.techLevel).toBe(1);

    // План хода целиком: подняться на всё золото и заморозить остаток
    // витрины — ровно то, что игрок сыграл сам.
    const plan = spendPlan(turn3Decision, { cards });
    expect(plan.steps.map((s) => s.recommendation.action)).toEqual(['levelUp', 'freeze']);
    expect(plan.steps[1]?.recommendation.spellCardId).toBe('BG28_512');

    // И в самом состоянии после подъёма совет тот же, а не «НИЧЕГО».
    expect(turn3AfterUpgrade.techLevelUpTurn).toBe(3);
    expect(turn3AfterUpgrade.shopSpells.map((s) => s.cardId)).toContain('BG28_512');
    const top = adviseTavern(turn3AfterUpgrade, { cards })?.recommendations[0];
    expect(top?.action).toBe('freeze');
    expect(top?.spellCardId).toBe('BG28_512');
    expect(top?.score).toBeGreaterThan(0);
  });

  it('ход 7: у модального заклинания названы ветви, а статы не удвоены (пункт 2)', () => {
    // Alliance Flag: «Choose One — Give a minion +{0}/+{1}; or +{2}/+{3}»,
    // теги сущности 3,1,1,3. Совет называл заклинание и цель, а какой
    // из двух эффектов брать — молчал.
    expect(turn7Flag).not.toBeNull();
    if (turn7Flag === null) return;

    const flag = turn7Flag.handSpells.find((x) => x.cardId === 'BG31_880');
    expect(flag?.scriptData).toEqual([3, 1, 1, 3]);
    if (flag === undefined) return;

    const effect = spellEffect(flag.cardId, flag.scriptData, cards);
    // Ветви — отдельные карты снапшота с теми же плейсхолдерами.
    expect(effect?.branches.map((b) => b.cardId)).toEqual(['BG31_880t', 'BG31_880t2']);
    expect(effect?.branches.map((b) => b.label)).toEqual(['+3/+1', '+1/+3']);
    // Сумма — ОДНОЙ ветви: прежний разбор складывал обе и обещал +8.
    expect(effect?.stats).toBe(4);

    const play = adviseTavern(turn7Flag, { cards })?.recommendations.find(
      (r) => r.action === 'play' && r.spellCardId === 'BG31_880',
    );
    expect(play).toBeDefined();
    expect(play?.targetMinion?.cardId).toBe('BGS_004');
    // Ветвь названа: одна — если её выбрал замер разделения статов,
    // обе — если по нашей шкале они равны и разделить нечем.
    expect((play?.spellBranches ?? []).length).toBeGreaterThan(0);
    expect(play?.reason).toContain('ветв');

    // И то же самое видно в короткой строке действия — её показывает
    // оверлей, и молчала именно она.
    if (play === undefined) return;
    const line = recommendationLine(play, cards);
    expect(line).toContain('Allied Mace +3/+1');
    expect(line).toContain('на Wrath Weaver');
  });

  it('ход 9: ралли вторым номером — совет подтверждается перебором (пункт 3)', () => {
    // «Rally: This plays a Blood Gem on itself» срабатывает при атаке
    // миньона, и игрок опасался, что вторым номером камп не доживёт.
    // Миньоны бьют слева направо: вторым номером камп бьёт вторым.
    // Проверяется не рассуждением, а счётом: советованная расстановка
    // против лучшей из тех, где камп стоит первым.
    expect(turn9).not.toBeNull();
    if (turn9 === null) return;
    const state = turn9;

    expect(state.board.map((m) => m.cardId)).toEqual([
      'BG33_886',
      'BGS_004',
      'BG26_174_G',
      'BG35_150',
    ]);

    const question = battleQuestion(state);
    expect(question).not.toBeNull();
    if (question === null) return;

    const simulator = sharedBattleSimulator();
    const gains = endOfTurnAuraGains(state.board, simulator.cards);
    const bases = question.setups.map((s) => toBattleInfo(s, 1));
    const per = Math.floor(6000 / bases.length);

    const outcome = (order: readonly number[]): number => {
      const board = withEndOfTurnAuras(
        order.map((i) => state.board[i] as Minion),
        gains,
      );
      let sum = 0;
      for (const [i, base] of bases.entries()) {
        const r = withSeededRandom(4242 + i, () => simulator.run(withPlayerBoard(base, board), per));
        sum += r.wonPercent + r.tiedPercent / 2;
      }
      return sum / bases.length;
    };

    // Камп (индекс 0) вторым — то, что советует расстановка.
    const advised = outcome([2, 0, 1, 3]);
    // Лучшее из «камп первым» по полному перебору 24 расстановок.
    const camperFirst = outcome([0, 2, 3, 1]);
    // И то, как стояло на самом деле.
    const played = outcome([0, 1, 2, 3]);

    expect(advised).toBeGreaterThan(camperFirst);
    expect(advised).toBeGreaterThan(played);
  }, 120_000);

  it('ход 27: аура на чужих не идёт в жертву продажи (пункт 4)', () => {
    // Brann Bronzebeard 27/29 при борде в сотни статов — слабейший по нашей
    // шкале и первый кандидат в продажу. Но шкала меряет тела, а он
    // удваивает боевые кличи ВСЕХ будущих покупок; в витрине того же хода
    // стоял Mind Muck с кличем-поглощением.
    expect(turn27).not.toBeNull();
    if (turn27 === null) return;

    expect(turn27.board.map((m) => m.cardId)).toContain('BG_LOE_077');
    expect(turn27.shop.map((m) => m.cardId)).toContain('BG23_357');

    const victim = weakestOwn(turn27, { cards }, DEFAULT_TAVERN_RULES);
    expect(victim?.minion.cardId).not.toBe('BG_LOE_077');

    const advice = adviseTavern(turn27, { cards });
    const topBuy = advice?.recommendations.find((r) => r.action === 'buy' && r.minion !== null);
    expect(topBuy?.sellFirst?.cardId).toBe('BG23_318');

    // И весь план хода не трогает Бранна ни одним шагом.
    const plan = spendPlan(turn27, { cards });
    const touched = plan.steps.flatMap((s) => [
      s.recommendation.sellFirst?.cardId,
      s.recommendation.action === 'sell' ? s.recommendation.minion?.cardId : undefined,
    ]);
    expect(touched).not.toContain('BG_LOE_077');

    // Клич кандидата и аура Бранна связаны — в обе стороны, как заклинания
    // в part18: Mind Muck выходит наверх списка покупок.
    expect(topBuy?.minion?.cardId).toBe('BG23_357');
  });
});
