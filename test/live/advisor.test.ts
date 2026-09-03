import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BattleSetup } from '../../src/advisors/battle/mapper.js';
import type { PositionAdvice } from '../../src/advisors/position/advisor.js';
import type { BuyCandidate, BuyCheckResult } from '../../src/advisors/tavern/simulated.js';
import {
  LiveAdvisor,
  situationKey,
  type BuyCheckSource,
  type PositionSource,
} from '../../src/live/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { EMPTY_STATE, type GameState, type Minion } from '../../src/state/types.js';
import { board, minion } from '../minions.js';

/**
 * Правила вызова советников в живом режиме.
 *
 * Проверяется то, чего нет ни в одной прошлой фазе: когда звать, когда молчать
 * и когда бросать начатое. Сам счёт подменён — его качество проверено фазой 3,
 * а поднимать здесь воркер значит мерить симулятор вместо правил.
 */

/** Счётчик расстановки, которым можно управлять из теста. */
class FakePosition implements PositionSource {
  readonly calls: (readonly BattleSetup[])[] = [];
  cancels = 0;
  #resolve: ((advice: PositionAdvice | null) => void) | null = null;

  advise(setups: readonly BattleSetup[]): Promise<PositionAdvice | null> {
    this.calls.push(setups);
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  cancel(): void {
    this.cancels += 1;
  }

  /** Ответить на последний запрос. */
  finish(advice: PositionAdvice | null): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(advice);
  }
}

/** Досчёт покупок, которым можно управлять из теста. */
class FakeBuys implements BuyCheckSource {
  readonly calls: { setups: readonly BattleSetup[]; candidates: readonly BuyCandidate[] }[] = [];
  cancels = 0;
  #resolve: ((result: BuyCheckResult | null) => void) | null = null;

  checkBuys(
    setups: readonly BattleSetup[],
    candidates: readonly BuyCandidate[],
  ): Promise<BuyCheckResult | null> {
    this.calls.push({ setups, candidates });
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  cancel(): void {
    this.cancels += 1;
  }

  finish(result: BuyCheckResult | null): void {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(result);
  }
}

const HERO: GameState['hero'] = {
  entityId: 64,
  cardId: 'BG20_HERO_282',
  health: 30,
  damage: 3,
  armor: 0,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

function tavernState(patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn: 9,
    techLevel: 3,
    gold: 7,
    goldTotal: 7,
    goldSpent: 0,
    hero: HERO,
    board: board([101, 102]),
    ...patch,
  };
}

/** Противник, которого мы уже видели: только тогда расстановку есть с чем считать. */
function withSeenOpponent(state: GameState, opponentBoard: readonly Minion[]): GameState {
  return {
    ...state,
    nextOpponentPlayerId: 5,
    lastSeenBoards: { 5: opponentBoard },
    lastSeenBoardTurns: { 5: state.turn - 2 },
  };
}

const QUIET = 40;

describe('живой советник: когда звать и когда бросать', () => {
  let cards: CardIndex;
  let position: FakePosition;

  beforeEach(() => {
    cards ??= loadCardIndex();
    position = new FakePosition();
  });

  it('одно и то же положение работы не поднимает', async () => {
    const onTavern = vi.fn();
    const advisor = new LiveAdvisor({ cards, position }, { onTavern }, { quietMs: QUIET });
    const state = tavernState();

    advisor.update(state);
    // Событий в фазе таверны сотни, и почти все не меняют положения дел.
    advisor.update({ ...state });
    advisor.update({ ...state, goldSpent: 0 });

    await vi.waitFor(() => {
      expect(onTavern).toHaveBeenCalledTimes(1);
    });
  });

  it('изменение положения отменяет незаконченный счёт немедленно', async () => {
    const advisor = new LiveAdvisor({ cards, position }, {}, { quietMs: QUIET });
    const state = withSeenOpponent(tavernState(), board([201]));

    advisor.update(state);
    await vi.waitFor(() => {
      expect(position.calls).toHaveLength(1);
    });

    // Игрок купил миньона, пока шёл счёт.
    advisor.update({ ...state, board: board([101, 102, 103]) });

    // Отмена не ждёт затишья: считаемое уже относится к прошлому положению.
    expect(position.cancels).toBeGreaterThan(0);
  });

  it('устаревший ответ показывается как брошенный, а не как совет', async () => {
    const onPosition = vi.fn();
    const advisor = new LiveAdvisor({ cards, position }, { onPosition }, { quietMs: QUIET });
    const state = withSeenOpponent(tavernState(), board([201]));

    advisor.update(state);
    await vi.waitFor(() => {
      expect(position.calls).toHaveLength(1);
    });

    advisor.update({ ...state, board: board([101, 102, 103]) });
    // Воркер успел досчитать до того, как заметил отмену: ответ пришёл, но он
    // про борд из двух миньонов, которого больше нет.
    position.finish({ improves: true } as unknown as PositionAdvice);

    await vi.waitFor(() => {
      expect(onPosition).toHaveBeenCalledWith(null, expect.anything(), expect.anything());
    });
  });

  it('ни одного виденного борда — счёт не начинается, но и молчания нет', async () => {
    const onNoOpponent = vi.fn();
    const advisor = new LiveAdvisor({ cards, position }, { onNoOpponent }, { quietMs: QUIET });

    // Следующий противник объявлен, но ни одного чужого борда ещё не видели —
    // первые ходы до первого боя.
    advisor.update({ ...tavernState(), nextOpponentPlayerId: 5 });

    await vi.waitFor(() => {
      expect(onNoOpponent).toHaveBeenCalledTimes(1);
    });
    expect(position.calls).toHaveLength(0);
    expect(onNoOpponent.mock.calls[0]?.[0]).toMatchObject({ source: 'unseen', usable: false });
  });

  it('следующего не видели, но поле есть — счёт идёт против поля', async () => {
    const onNoOpponent = vi.fn();
    const advisor = new LiveAdvisor({ cards, position }, { onNoOpponent }, { quietMs: QUIET });

    // Раньше здесь было молчание всю первую половину партии: следующий
    // противник ни разу не из числа виденных до 13-го хода. Теперь счёт идёт
    // против всех виденных бордов — по сетапу на каждый.
    advisor.update({
      ...tavernState(),
      nextOpponentPlayerId: 5,
      lastSeenBoards: { 6: board([201]), 7: board([202]) },
      lastSeenBoardTurns: { 6: 5, 7: 7 },
    });

    await vi.waitFor(() => {
      expect(position.calls).toHaveLength(1);
    });
    expect(position.calls[0]).toHaveLength(2);
    expect(onNoOpponent).not.toHaveBeenCalled();
  });

  it('в бою расстановку не считаем', async () => {
    const onTavern = vi.fn();
    const advisor = new LiveAdvisor({ cards, position }, { onTavern }, { quietMs: QUIET });

    advisor.update(withSeenOpponent({ ...tavernState(), phase: 'combat' }, board([201])));

    await vi.waitFor(() => {
      expect(onTavern).toHaveBeenCalledTimes(1);
    });
    expect(position.calls).toHaveLength(0);
  });

  it('досчёт покупок зовётся при выборе из двух и цели, кандидаты — верхние покупки', async () => {
    const buys = new FakeBuys();
    const advisor = new LiveAdvisor({ cards, position, buys }, {}, { quietMs: QUIET });
    const state = withSeenOpponent(tavernState({ shop: board([201, 202]) }), board([301]));

    advisor.update(state);
    await vi.waitFor(() => {
      expect(buys.calls).toHaveLength(1);
    });
    expect(buys.calls[0]?.candidates.length).toBeGreaterThanOrEqual(2);
    // Кандидат несёт борд «как выйдет в бой»: свои плюс покупка в конце.
    expect(buys.calls[0]?.candidates[0]?.boardAfter).toHaveLength(3);
  });

  it('без цели и при одной покупке досчёт молчит', async () => {
    const buys = new FakeBuys();
    const advisor = new LiveAdvisor({ cards, position, buys }, {}, { quietMs: QUIET });

    // Цели нет: ни одного виденного борда.
    advisor.update(tavernState({ shop: board([201, 202]) }));
    // Покупка одна: сравнивать нечего.
    advisor.update(withSeenOpponent(tavernState({ shop: board([201]) }), board([301])));

    await new Promise((resolve) => setTimeout(resolve, QUIET * 3));
    expect(buys.calls).toHaveLength(0);
  });

  it('устаревший досчёт покупок отдаётся как брошенный', async () => {
    const onBuyCheck = vi.fn();
    const buys = new FakeBuys();
    const advisor = new LiveAdvisor({ cards, position, buys }, { onBuyCheck }, { quietMs: QUIET });
    const state = withSeenOpponent(tavernState({ shop: board([201, 202]) }), board([301]));

    advisor.update(state);
    await vi.waitFor(() => {
      expect(buys.calls).toHaveLength(1);
    });

    // Игрок купил, пока считалось: отмена немедленная, результат — брошен.
    advisor.update({ ...state, board: board([101, 102, 103]) });
    expect(buys.cancels).toBeGreaterThan(0);
    buys.finish({ decisive: true } as unknown as BuyCheckResult);

    await vi.waitFor(() => {
      expect(onBuyCheck).toHaveBeenCalledWith(null, expect.anything(), expect.anything());
    });
  });

  it('ключ положения ловит покупку и не ловит служебные события', () => {
    const state = withSeenOpponent(tavernState(), board([201]));

    expect(situationKey(state)).toBe(situationKey({ ...state, anomalyCardId: 'что-то' }));
    expect(situationKey(state)).not.toBe(
      situationKey({ ...state, board: [...state.board, minion(103)] }),
    );
    expect(situationKey(state)).not.toBe(situationKey({ ...state, gold: 4 }));
  });

  it('открытие выбора тринкета — новое положение', () => {
    // Предложение открывается посреди хода, не меняя ни золота, ни бордов:
    // без него в ключе оверлей не проснулся бы и совет никто бы не увидел.
    const state = tavernState();
    const withOffer = {
      ...state,
      trinketOffer: [{ entityId: 900, cardId: 'BG30_MagicItem_425', subsetRaces: [], cost: null }],
    };
    expect(situationKey(state)).not.toBe(situationKey(withOffer));
  });

  it('открытие модального выбора карт — новое положение', () => {
    // part13, ход 5: раскопка «Нового ростка» открылась, не тронув ни золота,
    // ни бордов. Без выбора в ключе советник не пересчитался, и оверлей
    // показывал «НИЧЕГО» поверх трёх вариантов — на что игрок и указал.
    const state = tavernState();
    const withChoice = {
      ...state,
      openChoice: {
        id: 2,
        sourceCardId: 'BG33_101',
        options: [
          { entityId: 1202, cardId: 'BG26_146' },
          { entityId: 1203, cardId: 'BG25_001' },
        ],
      },
    };
    expect(situationKey(state)).not.toBe(situationKey(withChoice));
    // Закрытие выбора — тоже новое положение: старые «ВЫБРАТЬ?» гасятся.
    expect(situationKey(withChoice)).not.toBe(situationKey({ ...withChoice, openChoice: null }));
  });
});
