import { describe, expect, it } from 'vitest';

import {
  arrangementSpace,
  minionSignature,
} from '../../../src/advisors/position/arrangements.js';
import type { Minion } from '../../../src/state/types.js';

function minion(entityId: number, patch: Partial<Minion> = {}): Minion {
  return {
    entityId,
    cardId: 'BG31_815',
    zonePos: entityId,
    attack: 3,
    health: 4,
    taunt: false,
    divineShield: false,
    poisonous: false,
    venomous: false,
    reborn: false,
    windfury: false,
    stealth: false,
    golden: false,
    maxHealth: 4,
    techLevel: 3,
    enchantments: [],
    scriptData: [null, null, null, null, null, null],
    tags: {},
    ...patch,
  };
}

/** Мультимножество entityId — расстановка обязана состоять из тех же миньонов. */
function ids(board: readonly Minion[]): number[] {
  return board.map((m) => m.entityId).sort((a, b) => a - b);
}

describe('сигнатура миньона', () => {
  it('не зависит от entityId и позиции — иначе не склеится ни одна пара', () => {
    expect(minionSignature(minion(1, { zonePos: 1 }))).toBe(
      minionSignature(minion(2, { zonePos: 5 })),
    );
  });

  it('различает всё, что видит симулятор', () => {
    const base = minion(1);
    for (const patch of [
      { cardId: 'BG26_529' },
      { attack: 4 },
      { health: 5 },
      { maxHealth: 9 },
      { techLevel: 4 },
      { taunt: true },
      { divineShield: true },
      { poisonous: true },
      { venomous: true },
      { reborn: true },
      { windfury: true },
      { stealth: true },
      { golden: true },
      { scriptData: [2, null, null, null, null, null] },
      { tags: { ATK: 3 } },
    ] satisfies Partial<Minion>[]) {
      expect(minionSignature(minion(1, patch))).not.toBe(minionSignature(base));
    }
  });

  it('энчанты сравниваются содержимым, а не номерами сущностей', () => {
    const enchanted = (entityId: number, timing: number): Minion =>
      minion(entityId, {
        enchantments: [{ entityId: timing, cardId: 'BG_ENCH', timing, scriptDataNum1: 2, scriptDataNum2: null }],
      });
    expect(minionSignature(enchanted(1, 100))).toBe(minionSignature(enchanted(2, 900)));

    const other = minion(3, {
      enchantments: [
        { entityId: 100, cardId: 'BG_ENCH', timing: 100, scriptDataNum1: 3, scriptDataNum2: null },
      ],
    });
    expect(minionSignature(other)).not.toBe(minionSignature(enchanted(1, 100)));
  });
});

describe('пространство расстановок', () => {
  it('три разных миньона дают шесть расстановок, все различимы', () => {
    const board = [minion(1, { attack: 1 }), minion(2, { attack: 2 }), minion(3, { attack: 3 })];
    const space = arrangementSpace(board);

    expect(space.total).toBe(6);
    expect(space.distinct).toBe(6);

    const list = space.list();
    expect(list).toHaveLength(6);
    expect(new Set(list.map((a) => a.key)).size).toBe(6);
    for (const arrangement of list) expect(ids(arrangement.board)).toEqual([1, 2, 3]);
  });

  it('одинаковые миньоны не создают новых расстановок', () => {
    const board = [minion(1), minion(2), minion(3)];
    const space = arrangementSpace(board);

    expect(space.total).toBe(6);
    expect(space.distinct).toBe(1);
    expect(space.list()).toHaveLength(1);
  });

  it('пара одинаковых при одном отличном режет перебор вдвое', () => {
    const board = [minion(1), minion(2), minion(3, { taunt: true })];
    const space = arrangementSpace(board);

    expect(space.distinct).toBe(3);
    expect(space.list()).toHaveLength(3);
  });

  it('семь разных миньонов — это ровно 5040 расстановок', () => {
    const board = Array.from({ length: 7 }, (_, i) => minion(i + 1, { attack: i + 1 }));
    const space = arrangementSpace(board);

    expect(space.total).toBe(5040);
    expect(space.distinct).toBe(5040);

    const list = space.list();
    expect(list).toHaveLength(5040);
    expect(new Set(list.map((a) => a.key)).size).toBe(5040);
  });

  it('исходный борд получает ключ в порядке появления классов', () => {
    const board = [minion(1, { attack: 1 }), minion(2, { attack: 2 }), minion(3, { attack: 1 })];
    const space = arrangementSpace(board);
    expect(space.keyOf(board)).toBe('0,1,0');
    // Перестановка неразличимых миньонов — та же самая расстановка.
    expect(space.keyOf([board[2], board[1], board[0]] as Minion[])).toBe('0,1,0');
    expect(space.keyOf([board[1], board[0], board[2]] as Minion[])).toBe('1,0,0');
  });

  it('исходная расстановка всегда есть среди кандидатов', () => {
    const board = [
      minion(1, { attack: 1 }),
      minion(2, { attack: 2, taunt: true }),
      minion(3, { attack: 1 }),
      minion(4, { cardId: 'BG26_529' }),
    ];
    const space = arrangementSpace(board);
    const keys = new Set(space.list().map((a) => a.key));
    expect(keys.has(space.keyOf(board))).toBe(true);
  });

  it('пустой борд — одна пустая расстановка', () => {
    const space = arrangementSpace([]);
    expect(space.distinct).toBe(1);
    expect(space.list()).toEqual([{ board: [], key: '' }]);
  });
});
