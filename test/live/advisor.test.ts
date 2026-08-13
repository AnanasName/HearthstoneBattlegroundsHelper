import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BattleSetup } from '../../src/advisors/battle/mapper.js';
import type { PositionAdvice } from '../../src/advisors/position/advisor.js';
import { LiveAdvisor, situationKey, type PositionSource } from '../../src/live/advisor.js';
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
  readonly calls: BattleSetup[] = [];
  cancels = 0;
  #resolve: ((advice: PositionAdvice | null) => void) | null = null;

  advise(setup: BattleSetup): Promise<PositionAdvice | null> {
    this.calls.push(setup);
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

  it('без картинки противника счёт не начинается, но и молчания нет', async () => {
    const onNoOpponent = vi.fn();
    const advisor = new LiveAdvisor({ cards, position }, { onNoOpponent }, { quietMs: QUIET });

    // Следующий противник объявлен, но борда его мы не видели — обычное дело
    // до середины партии.
    advisor.update({ ...tavernState(), nextOpponentPlayerId: 5 });

    await vi.waitFor(() => {
      expect(onNoOpponent).toHaveBeenCalledTimes(1);
    });
    expect(position.calls).toHaveLength(0);
    expect(onNoOpponent.mock.calls[0]?.[0]).toMatchObject({ source: 'unseen', usable: false });
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
      trinketOffer: [{ entityId: 900, cardId: 'BG30_MagicItem_425' }],
    };
    expect(situationKey(state)).not.toBe(situationKey(withOffer));
  });
});
