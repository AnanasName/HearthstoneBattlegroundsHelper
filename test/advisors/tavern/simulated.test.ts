import { describe, expect, it } from 'vitest';

import type { BattleSetup } from '../../../src/advisors/battle/mapper.js';
import type { BattleSimulator } from '../../../src/advisors/battle/simulator.js';
import type { Recommendation, TavernAdvice } from '../../../src/advisors/tavern/advisor.js';
import {
  BuyCheckAborted,
  buyCheckQuestion,
  checkBuysWithBattle,
  DEFAULT_BUY_CHECK_OPTIONS,
} from '../../../src/advisors/tavern/simulated.js';
import { EMPTY_STATE, type GameState, type Hero, type Minion } from '../../../src/state/types.js';
import { board, minion } from '../../minions.js';

/**
 * Досчёт покупок симулятором: что досчитывать и как складывать счёт.
 *
 * Сам симулятор здесь подставной: его качество проверено фазой 2
 * и калибровкой, а эти тесты — про отбор кандидатов, послойное поле,
 * порог шума и флаг согласия с эвристикой.
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'BG20_HERO_282',
  health: 30,
  damage: 0,
  armor: 0,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

function state(patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn: 9,
    techLevel: 3,
    gold: 7,
    goldTotal: 7,
    hero: HERO,
    board: board([101, 102]),
    nextOpponentPlayerId: 5,
    lastSeenBoards: { 5: board([201]) },
    lastSeenBoardTurns: { 5: 7 },
    ...patch,
  };
}

function buyRec(minionOf: Minion, score: number, sellFirst: Minion | null = null): Recommendation {
  return {
    action: 'buy',
    minion: minionOf,
    score,
    cost: 3,
    requiresSlot: sellFirst !== null,
    sellFirst,
    reason: 'тест',
  };
}

function advice(recommendations: readonly Recommendation[]): TavernAdvice {
  return {
    recommendations,
    gold: 7,
    targetTier: 4,
    shopValues: [],
    trinkets: [],
    choice: [],
    playPlan: [],
    heroChoice: [],
    trinketForecast: null,
  };
}

describe('вопрос досчёта покупок', () => {
  it('берёт верхние покупки в порядке эвристики, борд — как выйдет в бой', () => {
    const shopA = minion(301, { cardId: 'SHOP_A' });
    const shopB = minion(302, { cardId: 'SHOP_B' });
    const q = buyCheckQuestion(state(), advice([buyRec(shopA, 10), buyRec(shopB, 8)]));

    expect(q).not.toBeNull();
    expect(q?.candidates.map((c) => c.cardId)).toEqual(['SHOP_A', 'SHOP_B']);
    // Кандидат встаёт в конец текущего борда.
    expect(q?.candidates[0]?.boardAfter.map((m) => m.entityId)).toEqual([101, 102, 301]);
    expect(q?.setups).toHaveLength(1);
  });

  it('жертва продажи в борде боя отсутствует', () => {
    const victim = minion(101);
    const shopA = minion(301, { cardId: 'SHOP_A' });
    const shopB = minion(302, { cardId: 'SHOP_B' });
    const q = buyCheckQuestion(
      state(),
      advice([buyRec(shopA, 10, victim), buyRec(shopB, 8)]),
    );

    expect(q?.candidates[0]?.boardAfter.map((m) => m.entityId)).toEqual([102, 301]);
  });

  it('покупка в руку на полном борде не досчитывается: бой она не меняет', () => {
    const full = state({ board: board([1, 2, 3, 4, 5, 6, 7]) });
    const shopA = minion(301, { cardId: 'SHOP_A' });
    const shopB = minion(302, { cardId: 'SHOP_B' });
    // Обе покупки без продажи — сравнивать боем нечего.
    expect(buyCheckQuestion(full, advice([buyRec(shopA, 10), buyRec(shopB, 8)]))).toBeNull();

    // Покупка через продажу бой меняет и досчитывается.
    const victim = full.board[0] ?? minion(1);
    const q = buyCheckQuestion(
      full,
      advice([buyRec(shopA, 10, victim), buyRec(shopB, 8, victim)]),
    );
    expect(q?.candidates).toHaveLength(2);
  });

  it('две копии одной карты — одно решение', () => {
    const shopA = minion(301, { cardId: 'SHOP_A' });
    const copyA = minion(302, { cardId: 'SHOP_A' });
    expect(buyCheckQuestion(state(), advice([buyRec(shopA, 10), buyRec(copyA, 9)]))).toBeNull();
  });

  it('молчит без цели и вне таверны', () => {
    const shopA = minion(301, { cardId: 'SHOP_A' });
    const shopB = minion(302, { cardId: 'SHOP_B' });
    const recs = [buyRec(shopA, 10), buyRec(shopB, 8)];

    expect(
      buyCheckQuestion(state({ lastSeenBoards: {}, lastSeenBoardTurns: {} }), advice(recs)),
    ).toBeNull();
    expect(buyCheckQuestion(state({ phase: 'combat' }), advice(recs))).toBeNull();
  });

  it('кандидатов не больше maxCandidates', () => {
    const recs = [301, 302, 303, 304].map((id, i) =>
      buyRec(minion(id, { cardId: `SHOP_${String(id)}` }), 10 - i),
    );
    const q = buyCheckQuestion(state(), advice(recs));
    expect(q?.candidates).toHaveLength(DEFAULT_BUY_CHECK_OPTIONS.maxCandidates);
  });

  it('пустой свой борд — не помеха: покупка и есть его наполнение', () => {
    const shopA = minion(301, { cardId: 'SHOP_A' });
    const shopB = minion(302, { cardId: 'SHOP_B' });
    const q = buyCheckQuestion(state({ board: [] }), advice([buyRec(shopA, 10), buyRec(shopB, 8)]));
    expect(q?.candidates[0]?.boardAfter.map((m) => m.entityId)).toEqual([301]);
  });
});

/** Подставной симулятор: исход зависит от последнего миньона борда. */
function fakeSimulator(outcomeByCardId: Record<string, number>): BattleSimulator {
  const run = (input: { playerBoard: { board: { cardId: string }[] } }): unknown => {
    const last = input.playerBoard.board[input.playerBoard.board.length - 1];
    const won = outcomeByCardId[last?.cardId ?? ''] ?? 0;
    return { wonPercent: won, tiedPercent: 0, lostPercent: 100 - won };
  };
  // Сервис карт нужен баффам конца хода; здесь карт с ними нет.
  const cards = { getCard: () => undefined };
  return { run, cards } as unknown as BattleSimulator;
}

function setup(opponentBoard: readonly Minion[]): BattleSetup {
  return {
    turn: 9,
    playerBoard: board([101, 102]),
    opponentBoard,
    playerHero: HERO,
    techLevel: 3,
    anomalyCardId: null,
    globalInfo: EMPTY_STATE.globalInfo,
    playerTrinketDbfIds: [],
    opponentTrinketDbfIds: [],
  };
}

const CANDIDATES = [
  { cardId: 'SHOP_A', entityId: 301, boardAfter: [...board([101, 102]), minion(301, { cardId: 'SHOP_A' })] },
  { cardId: 'SHOP_B', entityId: 302, boardAfter: [...board([101, 102]), minion(302, { cardId: 'SHOP_B' })] },
];

describe('счёт покупок боем', () => {
  it('исходы по убыванию, разброс и согласие с эвристикой', () => {
    const result = checkBuysWithBattle(
      { setups: [setup(board([201]))], candidates: CANDIDATES },
      { simulator: fakeSimulator({ SHOP_A: 40, SHOP_B: 60 }) },
    );

    expect(result.outcomes.map((o) => o.cardId)).toEqual(['SHOP_B', 'SHOP_A']);
    expect(result.spread).toBeCloseTo(20);
    // Эвристика ставила первой SHOP_A, бой выбрал SHOP_B.
    expect(result.agreed).toBe(false);
    expect(result.decisive).toBe(true);
  });

  it('поле бордов: симуляции делятся, исход — среднее', () => {
    // SHOP_A выигрывает у одного борда и проигрывает другому: среднее 50.
    const bySecondBoard = (input: { opponentBoard: { board: { cardId: string }[] } }): number =>
      input.opponentBoard.board[0]?.cardId === 'CARD_201' ? 100 : 0;
    const run = (input: {
      playerBoard: { board: { cardId: string }[] };
      opponentBoard: { board: { cardId: string }[] };
    }): unknown => ({
      wonPercent: bySecondBoard(input),
      tiedPercent: 0,
      lostPercent: 100 - bySecondBoard(input),
    });
    const simulator = { run, cards: { getCard: () => undefined } } as unknown as BattleSimulator;

    const result = checkBuysWithBattle(
      { setups: [setup(board([201])), setup(board([202]))], candidates: CANDIDATES },
      { simulator },
      { simulations: 800, maxCandidates: 3 },
    );

    expect(result.outcomes[0]?.outcome).toBeCloseTo(50);
    // 800 симуляций делятся между двумя бордами: по 400, суммарно те же 800.
    expect(result.outcomes[0]?.sims).toBe(800);
  });

  it('порог шума выведен из числа симуляций, разброс ниже — не решает', () => {
    const result = checkBuysWithBattle(
      { setups: [setup(board([201]))], candidates: CANDIDATES },
      { simulator: fakeSimulator({ SHOP_A: 51, SHOP_B: 53 }) },
      { simulations: 800, maxCandidates: 3 },
    );

    // Два стандартных отклонения разности долей: 2·√(0.5/800)·100 = 5 п.п.
    expect(result.noise).toBeCloseTo(5, 1);
    expect(result.spread).toBeCloseTo(2);
    expect(result.decisive).toBe(false);
  });

  it('отмена бросает счёт исключением', () => {
    expect(() =>
      checkBuysWithBattle(
        { setups: [setup(board([201]))], candidates: CANDIDATES },
        { simulator: fakeSimulator({}), aborted: () => true },
      ),
    ).toThrow(BuyCheckAborted);
  });
});
