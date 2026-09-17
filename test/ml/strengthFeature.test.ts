import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BattleSimulator } from '../../src/advisors/battle/simulator.js';
import type { FieldBoard, FieldSnapshot } from '../../src/advisors/strength/boards.js';
import { DEFAULT_FIELD_STRENGTH_OPTIONS } from '../../src/advisors/strength/strength.js';
import type { TavernTurn } from '../../src/advisors/tavern/turns.js';
import type { DatasetGame } from '../../src/ml/dataset.js';
import { extractHistoryFeatures } from '../../src/ml/historyFeatures.js';
import {
  buildFixtureIndex,
  firstPointKey,
  gameStrengths,
  INDICATOR_FEATURE_NAMES,
  indicatorExtractor,
  partFromFileName,
  partOfGame,
  recordKey,
  STRENGTH_FEATURE_NAMES,
  StrengthCache,
  strengthColumns,
  strengthExtractor,
  strengthStamp,
  symmetricState,
  type FixtureIndex,
  type StrengthPoint,
} from '../../src/ml/strengthFeature.js';
import { EMPTY_GLOBAL_INFO, type GameState, type Hero, EMPTY_STATE } from '../../src/state/types.js';
import { minion } from '../minions.js';

/**
 * Сила стола как признак — замер 6б (docs/ml.md). Держится то, что
 * предрегистрировано: значение и два флага стадии, база без значения,
 * счётчики боя с обеих сторон пустые, партия не мерится об свои борды,
 * запись сопоставляется с фикстурой без героя и места, а кэш не отдаёт
 * число, посчитанное при других условиях.
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'H',
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
  heroPowerDisabled: false,
  heroPowerScriptData: [],
};

function stateOf(patch: Partial<GameState>): GameState {
  return { ...EMPTY_STATE, phase: 'tavern', hero: HERO, playerId: 3, techLevel: 2, ...patch };
}

function gameOf(fileName: string, states: readonly GameState[], patch: Partial<DatasetGame['record']> = {}): DatasetGame {
  return {
    fileName,
    finalPlace: 3,
    record: {
      savedAt: '2026-09-17T00:00:00.000Z',
      buildNumber: 251952,
      heroCardId: 'H',
      finalPlace: 3,
      checkpoints: states.map((state) => ({ turn: state.turn, state })),
      ...patch,
    },
  };
}

const fieldBoard = (part: number, tavernTurn: number): FieldBoard => ({
  tavernTurn,
  part,
  turn: tavernTurn * 2 - 1,
  board: [minion(900 + part)],
  trinketDbfIds: [],
});

const snapshot: FieldSnapshot = {
  builtAt: '2026-09-17T00:00:00.000Z',
  parts: [1, 2, 3, 4],
  boards: [1, 2, 3, 4].map((p) => fieldBoard(p, 3)),
  damage: [],
};

interface SeenBattle {
  readonly opponent: number;
  readonly counters: unknown;
}

/** Симулятор-заглушка: побеждает всех, кроме борда партии 1, и помнит, что ему дали. */
function fakeSimulator(): { simulator: BattleSimulator; seen: SeenBattle[] } {
  const seen: SeenBattle[] = [];
  const simulator = {
    cards: null as never,
    cardsData: null as never,
    run: (info: {
      opponentBoard: { board: { entityId: number }[] };
      playerBoard: { player: { globalInfo?: unknown } };
    }) => {
      const id = info.opponentBoard.board[0]?.entityId ?? 0;
      seen.push({ opponent: id, counters: info.playerBoard.player.globalInfo });
      return { wonPercent: id === 901 ? 0 : 100, tiedPercent: 0 } as never;
    },
  } as unknown as BattleSimulator;
  return { simulator, seen };
}

describe('столбцы силы стола', () => {
  it('значение и два флага стадии: пустой борд и узкое поле', () => {
    expect(strengthColumns(62.5)).toEqual([12.5, 0, 0]);
    expect(strengthColumns('board')).toEqual([0, 1, 0]);
    expect(strengthColumns('field')).toEqual([0, 0, 1]);
  });

  it('B1 дописывает три столбца к признакам замера 4, база B0 — только флаги', () => {
    const states = [stateOf({ turn: 1 }), stateOf({ turn: 3 }), stateOf({ turn: 31 })];
    const points: StrengthPoint[] = ['board', 70, 'field'];
    const at = (i: number): GameState => states[i] ?? stateOf({});
    const b1 = strengthExtractor(points);
    const b0 = indicatorExtractor(points);
    expect(b1(at(1), 1, states)).toEqual([...extractHistoryFeatures(at(1), 1, states), 20, 0, 0]);
    expect(b0(at(1), 1, states)).toEqual([...extractHistoryFeatures(at(1), 1, states), 0, 0]);
    expect(b1(at(0), 0, states).slice(-3)).toEqual([0, 1, 0]);
    expect(b0(at(2), 2, states).slice(-2)).toEqual([0, 1]);
    expect(b1(at(0), 0, states)).toHaveLength(STRENGTH_FEATURE_NAMES.length);
    expect(b0(at(0), 0, states)).toHaveLength(INDICATOR_FEATURE_NAMES.length);
  });
});

describe('сопоставление записи с фикстурой', () => {
  const first = (shop: readonly string[], patch: Partial<GameState> = {}): GameState =>
    stateOf({ turn: 1, buildNumber: 251952, shop: shop.map((c, i) => minion(i + 1, { cardId: c })), ...patch });

  it('досбор называет партию в имени файла', () => {
    expect(partFromFileName('backfill_part25_b248348_p3.json')).toBe(25);
    expect(partFromFileName('2026-09-16T14-28-12_b251952_p3.json')).toBeNull();
  });

  it('отпечаток первой точки не зависит от героя, места и порядка витрины', () => {
    const a = gameOf('a.json', [first(['X', 'Y', 'Z'])], { heroCardId: 'H1', finalPlace: 6 });
    const b = gameOf('b.json', [first(['Z', 'X', 'Y'], { hero: { ...HERO, cardId: 'H2' } })], {
      heroCardId: 'H2',
      finalPlace: 5,
    });
    expect(recordKey(a.record)).toBe(recordKey(b.record));
    expect(recordKey(a.record)).toBe('251952|1|X,Y,Z');
    expect(firstPointKey(null, undefined)).toBe('');
  });

  it('живая запись находит фикстуру по отпечатку; двусмысленный отпечаток и фикстура без лога названы', () => {
    const turns: Record<number, TavernTurn> = {
      10: { turn: 1, state: first(['A', 'B', 'C']) },
      44: { turn: 1, state: first(['D', 'E', 'F']) },
      45: { turn: 1, state: first(['G', 'H', 'I']) },
      46: { turn: 1, state: first(['G', 'H', 'I']) },
    };
    const index = buildFixtureIndex([10, 44, 45, 46, 47], (p) => turns[p]);
    expect([...index.ambiguous.entries()]).toEqual([['251952|1|G,H,I', [45, 46]]]);
    expect(index.missing).toEqual([47]);

    const live = (shop: readonly string[]): DatasetGame => gameOf('2026-09-06T10-20-08_b250339_p6.json', [first(shop)]);
    expect(partOfGame(live(['F', 'E', 'D']), index)).toBe(44);
    expect(partOfGame(live(['G', 'H', 'I']), index)).toBeNull();
    expect(partOfGame(live(['Q', 'R', 'S']), index)).toBeNull();
    // Имя файла досбора сильнее отпечатка.
    expect(partOfGame(gameOf('backfill_part7_b248348_p7.json', [first(['A', 'B', 'C'])]), index)).toBe(7);
  });
});

describe('сила по точкам партии', () => {
  const options = { ...DEFAULT_FIELD_STRENGTH_OPTIONS, minBoards: 3 };

  it('партия не мерится об борды собственных соперников', () => {
    const { simulator, seen } = fakeSimulator();
    const game = gameOf('g.json', [stateOf({ turn: 5, board: [minion(1)] })]);
    // Без партии 1 в поле остаются три борда, и все три выиграны.
    expect(gameStrengths(game, 1, snapshot, simulator, options)).toEqual([100]);
    expect(seen.map((s) => s.opponent)).toEqual([902, 903, 904]);
  });

  it('без номера партии поле целое; пустой борд и узкое поле — разные причины', () => {
    const { simulator } = fakeSimulator();
    const game = gameOf('g.json', [
      stateOf({ turn: 5, board: [minion(1)] }),
      stateOf({ turn: 5, board: [] }),
      stateOf({ turn: 7, board: [minion(1)] }),
    ]);
    expect(gameStrengths(game, null, snapshot, simulator, options)).toEqual([75, 'board', 'field']);
  });

  it('свои счётчики боя не уходят в симулятор: у бордов поля их нет (D205)', () => {
    const counted = stateOf({
      turn: 5,
      board: [minion(1)],
      globalInfo: { ...EMPTY_GLOBAL_INFO, undeadAttackBuff: 6 },
    });
    expect(symmetricState(counted).globalInfo).toEqual(EMPTY_GLOBAL_INFO);
    const withCounters = fakeSimulator();
    const without = fakeSimulator();
    gameStrengths(gameOf('g.json', [counted]), null, snapshot, withCounters.simulator, options);
    gameStrengths(gameOf('g.json', [symmetricState(counted)]), null, snapshot, without.simulator, options);
    expect(withCounters.seen.map((s) => s.counters)).toEqual(without.seen.map((s) => s.counters));
  });
});

describe('кэш силы стола', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('отдаёт посчитанное только при тех же условиях и том же содержимом точек', () => {
    dir = mkdtempSync(join(tmpdir(), 'ml6-'));
    const path = join(dir, 'nested', 'cache.json');
    const game = gameOf('g.json', [stateOf({ turn: 5 }), stateOf({ turn: 7 })]);
    let computed = 0;
    const compute = (): StrengthPoint[] => {
      computed += 1;
      return [computed, 'field'];
    };

    expect(new StrengthCache(path).strengths(game, 4, 'stamp', compute)).toEqual([1, 'field']);
    // Новый экземпляр читает файл: те же условия — из кэша.
    expect(new StrengthCache(path).strengths(game, 4, 'stamp', compute)).toEqual([1, 'field']);
    expect(computed).toBe(1);
    // Другие условия или другой номер партии — пересчёт.
    expect(new StrengthCache(path).strengths(game, 4, 'other', compute)).toEqual([2, 'field']);
    expect(new StrengthCache(path).strengths(game, 5, 'other', compute)).toEqual([3, 'field']);
    // Запись с тем же именем, но другим содержимым — тоже.
    const rebuilt = gameOf('g.json', [stateOf({ turn: 5, techLevel: 3 }), stateOf({ turn: 7 })]);
    expect(new StrengthCache(path).strengths(rebuilt, 5, 'other', compute)).toEqual([4, 'field']);
    // Режим пересчёта кэш не читает.
    expect(new StrengthCache(path, true).strengths(rebuilt, 5, 'other', compute)).toEqual([5, 'field']);
    expect(computed).toBe(5);
  });

  it('индекс фикстур переиспользуется при том же списке, а без части логов не кэшируется', () => {
    dir = mkdtempSync(join(tmpdir(), 'ml6-'));
    const path = join(dir, 'cache.json');
    let built = 0;
    let missing: number[] = [8];
    const build = (): FixtureIndex => {
      built += 1;
      return { byKey: new Map([['k', 7]]), ambiguous: new Map(), missing };
    };
    new StrengthCache(path).fixtureIndex([7, 8], build);
    new StrengthCache(path).fixtureIndex([7, 8], build);
    expect(built).toBe(2);
    missing = [];
    new StrengthCache(path).fixtureIndex([7, 8], build);
    expect(new StrengthCache(path).fixtureIndex([7, 8], build).byKey.get('k')).toBe(7);
    expect(built).toBe(3);
    // Другой список партий или режим пересчёта — пересборка.
    new StrengthCache(path).fixtureIndex([7, 8, 9], build);
    new StrengthCache(path, true).fixtureIndex([7, 8, 9], build);
    expect(built).toBe(5);
  });

  it('штамп условий меняется от поля, опций, кода и версии симулятора', () => {
    const base = strengthStamp(snapshot, DEFAULT_FIELD_STRENGTH_OPTIONS, 'abc', '1.1.737', 'нет-такого-файла');
    expect(strengthStamp(snapshot, DEFAULT_FIELD_STRENGTH_OPTIONS, 'abc+грязное', '1.1.737', 'нет-такого-файла')).not.toBe(base);
    expect(strengthStamp(snapshot, DEFAULT_FIELD_STRENGTH_OPTIONS, 'abc', '1.1.738', 'нет-такого-файла')).not.toBe(base);
    expect(
      strengthStamp(snapshot, { ...DEFAULT_FIELD_STRENGTH_OPTIONS, simulations: 41 }, 'abc', '1.1.737', 'нет-такого-файла'),
    ).not.toBe(base);
    const moved = { ...snapshot, boards: [...snapshot.boards.slice(1), fieldBoard(9, 3)] };
    expect(strengthStamp(moved, DEFAULT_FIELD_STRENGTH_OPTIONS, 'abc', '1.1.737', 'нет-такого-файла')).not.toBe(base);
  });
});
