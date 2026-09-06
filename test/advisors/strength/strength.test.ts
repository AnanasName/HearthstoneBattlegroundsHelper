import { describe, expect, it } from 'vitest';

import type { FieldBoard, FieldSnapshot } from '../../../src/advisors/strength/boards.js';
import { boardsOfTurn } from '../../../src/advisors/strength/boards.js';
import {
  DEFAULT_FIELD_STRENGTH_OPTIONS,
  fieldStrength,
  fieldStrengthQuestion,
} from '../../../src/advisors/strength/strength.js';
import type { BattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { EMPTY_STATE, type GameState, type Hero } from '../../../src/state/types.js';
import { minion } from '../../minions.js';

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
  heroPowerLocked: false,
  heroPowerHasActivate: false,
  heroPowerExhausted: null,
  heroPowerScriptData: [],
};

const board = (part: number, tavernTurn: number): FieldBoard => ({
  tavernTurn,
  part,
  turn: tavernTurn * 2,
  board: [minion(900 + part)],
  trinketDbfIds: [],
});

/** Поле из `count` бордов одного хода — по одному на партию, как в жизни. */
const field = (tavernTurn: number, count: number): FieldBoard[] =>
  Array.from({ length: count }, (_, i) => board(i + 1, tavernTurn));

const snapshotOf = (boards: readonly FieldBoard[], damage: FieldSnapshot['damage'] = []): FieldSnapshot => ({
  builtAt: '2026-09-06T00:00:00.000Z',
  parts: [4, 5],
  boards,
  damage,
});

const stateOf = (patch: Partial<GameState> = {}): GameState => ({
  ...EMPTY_STATE,
  phase: 'tavern',
  turn: 11,
  techLevel: 4,
  hero: HERO,
  board: [minion(1), minion(2)],
  ...patch,
});

/**
 * Симулятор-заглушка: отдаёт заранее заданный исход и считает вызовы.
 *
 * Настоящий симулятор сюда не зовётся намеренно — он проверен в фазе 2,
 * а здесь проверяются правила «когда считать и что усреднять». Со снапшотом
 * карт каждый такой тест стоил бы секунды.
 */
function fakeSimulator(outcomes: readonly { won: number; tied: number }[]): {
  simulator: BattleSimulator;
  calls: () => number;
} {
  let call = 0;
  const simulator = {
    cards: null as never,
    cardsData: null as never,
    run: () => {
      const outcome = outcomes[call % outcomes.length] ?? { won: 0, tied: 0 };
      call += 1;
      return { wonPercent: outcome.won, tiedPercent: outcome.tied } as never;
    },
  } as unknown as BattleSimulator;
  return { simulator, calls: () => call };
}

describe('поле эталонных бордов', () => {
  it('отдаёт борды только своего хода и умеет исключить партию', () => {
    const snapshot = snapshotOf([...field(6, 3), ...field(7, 2)]);

    expect(boardsOfTurn(snapshot, 6)).toHaveLength(3);
    expect(boardsOfTurn(snapshot, 7)).toHaveLength(2);
    // Партия исключается целиком: борд соперника из того же лога — это
    // ответ, взятый у самого себя.
    expect(boardsOfTurn(snapshot, 6, 1)).toHaveLength(2);
  });

  it('пустой борд полем не считается', () => {
    const snapshot = snapshotOf([{ ...board(1, 6), board: [] }, ...field(6, 2)]);
    expect(boardsOfTurn(snapshot, 6)).toHaveLength(2);
  });
});

describe('сила стола: когда считать', () => {
  const options = { ...DEFAULT_FIELD_STRENGTH_OPTIONS, minBoards: 3 };

  it('молчит без снапшота — у свежей установки его нет', () => {
    expect(fieldStrengthQuestion(stateOf(), null, options)).toBeNull();
  });

  it('молчит на пустом борде: это «стола ещё нет», а не «сила ноль»', () => {
    const snapshot = snapshotOf(field(6, 5));
    expect(fieldStrengthQuestion(stateOf({ board: [] }), snapshot, options)).toBeNull();
  });

  it('молчит вне таверны — в бою игрок видит исход сам', () => {
    const snapshot = snapshotOf(field(6, 5));
    expect(fieldStrengthQuestion(stateOf({ phase: 'combat' }), snapshot, options)).toBeNull();
  });

  it('молчит, когда поле хода слишком узкое', () => {
    // Ход 6 (turn 11) с двумя бордами при пороге в три: «сильнее 2 из 2»
    // звучит так же уверенно, как «сильнее 41 из 41», ничего не зная.
    const snapshot = snapshotOf(field(6, 2));
    expect(fieldStrengthQuestion(stateOf(), snapshot, options)).toBeNull();
  });

  it('берёт поле СВОЕГО хода таверны, а не всё подряд', () => {
    const snapshot = snapshotOf([...field(6, 4), ...field(9, 40)]);
    const question = fieldStrengthQuestion(stateOf(), snapshot, options);

    expect(question?.tavernTurn).toBe(6);
    expect(question?.setups).toHaveLength(4);
  });

  it('кладёт в бой руку и свои тринкеты — как это делает расстановка', () => {
    const snapshot = snapshotOf(field(6, 4));
    const state = stateOf({
      hand: [minion(30)],
      playerId: 2,
      trinketsByPlayer: { 2: [111] },
    });

    const question = fieldStrengthQuestion(state, snapshot, options);
    expect(question?.setups[0]?.playerHand).toHaveLength(1);
    expect(question?.setups[0]?.playerTrinketDbfIds).toEqual([111]);
  });
});

describe('сила стола: что за число', () => {
  const options = { ...DEFAULT_FIELD_STRENGTH_OPTIONS, minBoards: 3 };

  it('усредняет исход по ВСЕМУ полю, считая ничью половиной победы', () => {
    const snapshot = snapshotOf(field(6, 4));
    const { simulator, calls } = fakeSimulator([
      { won: 100, tied: 0 },
      { won: 0, tied: 0 },
      { won: 50, tied: 50 },
      { won: 0, tied: 100 },
    ]);

    const strength = fieldStrength(stateOf(), snapshot, simulator, options);

    // (100 + 0 + 75 + 50) / 4
    expect(strength?.percent).toBeCloseTo(56.25, 5);
    expect(strength?.boards).toBe(4);
    // Один прогон на борд: поле широкое, симуляций мало — это замеренное
    // решение, и лишний вызов на борд удвоил бы цену блока.
    expect(calls()).toBe(4);
  });

  it('подставляет цену поражения этого хода из снапшота', () => {
    const snapshot = snapshotOf(field(6, 4), [
      { tavernTurn: 6, mean: 7.5, losses: 23 },
      { tavernTurn: 9, mean: 13.5, losses: 11 },
    ]);
    const { simulator } = fakeSimulator([{ won: 40, tied: 0 }]);

    const strength = fieldStrength(stateOf(), snapshot, simulator, options);

    expect(strength?.damageOnLoss).toBeCloseTo(7.5, 5);
    expect(strength?.damageLosses).toBe(23);
  });

  it('без замеренной цены поражения оставляет её пустой, а не нулём', () => {
    const snapshot = snapshotOf(field(6, 4));
    const { simulator } = fakeSimulator([{ won: 40, tied: 0 }]);

    const strength = fieldStrength(stateOf(), snapshot, simulator, options);

    // Ноль читался бы как «проигрыш ничего не стоит» — это ложь, а не
    // отсутствие данных.
    expect(strength?.damageOnLoss).toBeNull();
    expect(strength?.damageLosses).toBe(0);
  });

  it('на одном положении даёт одно и то же число', () => {
    // Иначе блок мигал бы у игрока на глазах, и выглядело бы это как смена
    // положения, а не как шум мерки.
    const snapshot = snapshotOf(field(6, 4));
    const first = fieldStrength(stateOf(), snapshot, fakeSimulator([{ won: 60, tied: 20 }]).simulator, options);
    const second = fieldStrength(stateOf(), snapshot, fakeSimulator([{ won: 60, tied: 20 }]).simulator, options);

    expect(first?.percent).toBe(second?.percent);
  });
});
