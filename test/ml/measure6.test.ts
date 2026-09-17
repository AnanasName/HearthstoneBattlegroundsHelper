import { describe, expect, it } from 'vitest';

import type { FieldBoard, FieldSnapshot } from '../../src/advisors/strength/boards.js';
import type { DatasetGame } from '../../src/ml/dataset.js';
import type { GameEval } from '../../src/ml/evaluate.js';
import {
  additionResult,
  applyLabelCorrections,
  EXPECTED_UNMAPPED,
  fieldFlipCount,
  KNOWN_DUPLICATES,
  LABEL_CORRECTIONS,
  mappingProblems,
  measure6Sample,
  placeShiftPerTenPoints,
  REPRODUCE_17_09,
  reproduces,
  sampleFingerprint,
  SEED,
  TAIL,
  MDE_Z,
  CONTROL_LEAK_THRESHOLD,
} from '../../src/ml/measure6.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
import { minion } from '../minions.js';

/**
 * Замер 6 — числа и проверки, которые решают вердикт и годность.
 * Константы сверяются с предрегистрацией docs/ml.md («Замер 6»):
 * поменять их — значит перезапускать замер, а не подкручивать.
 */

function gameOf(fileName: string, finalPlace: number, turns: readonly number[], board = true): DatasetGame {
  const state = (turn: number): GameState => ({
    ...EMPTY_STATE,
    phase: 'tavern',
    turn,
    board: board ? [minion(1)] : [],
  });
  return {
    fileName,
    finalPlace,
    record: {
      savedAt: '2026-09-17T00:00:00.000Z',
      buildNumber: 251952,
      heroCardId: 'H',
      finalPlace,
      checkpoints: turns.map((turn) => ({ turn, state: state(turn) })),
    },
  };
}

const evalOf = (name: string, maeModel: number): GameEval => ({
  name,
  finalPlace: 1,
  maeModel,
  maeCurrent: 0,
  maeMean: 0,
  checkpoints: [],
});

describe('константы замера 6 — как в предрегистрации', () => {
  it('зёрна, хвост, МРЭ и порог контроля', () => {
    expect(SEED).toEqual({
      bandA: 20260917,
      controlA: 20260918,
      bandB: 20260919,
      controlB: 20260920,
      tableB: 20260921,
      b2B: 20260922,
    });
    expect(TAIL).toBe(0.025);
    expect(MDE_Z).toBe(1.96);
    expect(CONTROL_LEAK_THRESHOLD).toBe(0.05);
    expect(EXPECTED_UNMAPPED).toEqual([
      '2026-08-28T14-43-31_b250339_p3.json',
      'own_2026-08-29T12-16-53_g1_b250339_p7.json',
    ]);
    expect(KNOWN_DUPLICATES).toEqual({
      '2026-08-27T18-49-39_b250339_p7.json': 'backfill_part31_b250339_p6.json',
      '2026-08-28T15-17-40_b250339_p5.json': 'backfill_part35_b250339_p5.json',
      '2026-09-04T22-42-32_b250339_p3.json': 'backfill_part41_b250339_p3.json',
    });
    expect(LABEL_CORRECTIONS).toEqual({ '2026-09-06T10-20-08_b250339_p6.json': 5 });
    expect(REPRODUCE_17_09).toEqual({
      m3: { mae: 1.677, dTable: 0.439, d2: 0.05 },
      m4: { mae: 1.629, dTable: 0.487, d2: 0.098 },
    });
  });
});

describe('годность сопоставления с фикстурами', () => {
  const clean = {
    unmapped: [...EXPECTED_UNMAPPED],
    byPart: new Map([
      [4, ['backfill_part4_b248348_p7.json']],
      [44, ['2026-09-06T10-20-08_b250339_p6.json']],
    ]),
    ambiguous: [],
    notInField: [],
    missingLogs: [],
  };

  it('две известные записи без лога — годно', () => {
    expect(mappingProblems(clean)).toEqual([]);
  });

  it('любая другая несопоставленная запись, двойник, двусмысленность или дыра в поле — недействительно', () => {
    expect(mappingProblems({ ...clean, unmapped: [...EXPECTED_UNMAPPED, 'x.json'] })).toEqual([
      'запись без фикстуры вне известного списка: x.json',
    ]);
    expect(mappingProblems({ ...clean, byPart: new Map([[44, ['a.json', 'b.json']]]) })).toHaveLength(1);
    expect(mappingProblems({ ...clean, ambiguous: ['a.json'] })).toHaveLength(1);
    expect(mappingProblems({ ...clean, notInField: [44] })).toHaveLength(1);
    expect(mappingProblems({ ...clean, missingLogs: [12] })).toHaveLength(1);
  });
});

describe('выборка замера 6', () => {
  it('двойник уходит, только если его пара в выборке есть', () => {
    const live = gameOf('2026-08-27T18-49-39_b250339_p7.json', 7, [1, 3]);
    const twin = gameOf('backfill_part31_b250339_p6.json', 6, [1, 3]);
    expect(measure6Sample([live, twin]).games.map((g) => g.fileName)).toEqual([twin.fileName]);
    expect(measure6Sample([live, twin]).dropped).toEqual([
      'двойник 2026-08-27T18-49-39_b250339_p7.json (остаётся backfill_part31_b250339_p6.json)',
    ]);
    // Без пары запись — единственный носитель партии и остаётся.
    expect(measure6Sample([live]).games).toHaveLength(1);
  });

  it('точки с бордом больше семи миньонов исключаются и называются', () => {
    const glued = gameOf('backfill_part35_b250339_p5.json', 5, [21, 23]);
    const broken: DatasetGame = {
      ...glued,
      record: {
        ...glued.record,
        checkpoints: glued.record.checkpoints.map((cp) =>
          cp.turn === 23
            ? { ...cp, state: { ...cp.state, board: Array.from({ length: 13 }, (_, i) => minion(i + 1)) } }
            : cp,
        ),
      },
    };
    const out = measure6Sample([broken]);
    expect(out.games[0]?.record.checkpoints.map((cp) => cp.turn)).toEqual([21]);
    expect(out.dropped).toEqual(['backfill_part35_b250339_p5.json: точки ходов 23 — борд больше 7']);
    // Исходная запись не тронута.
    expect(broken.record.checkpoints).toHaveLength(2);
  });
});

describe('поправки меток и отпечаток выборки', () => {
  it('поправка part44 применяется в памяти и называется', () => {
    const games = [gameOf('2026-09-06T10-20-08_b250339_p6.json', 6, [1]), gameOf('a.json', 3, [1])];
    const out = applyLabelCorrections(games);
    expect(out.games.map((g) => g.finalPlace)).toEqual([5, 3]);
    expect(out.games[0]?.record.finalPlace).toBe(5);
    expect(out.applied).toEqual(['2026-09-06T10-20-08_b250339_p6.json: 6 → 5']);
    // Исходные объекты не тронуты.
    expect(games[0]?.finalPlace).toBe(6);
  });

  it('отпечаток не зависит от порядка и меняется от числа точек и места', () => {
    const a = gameOf('a.json', 3, [1, 3]);
    const b = gameOf('b.json', 5, [1]);
    expect(sampleFingerprint([a, b])).toBe(sampleFingerprint([b, a]));
    expect(sampleFingerprint([a, gameOf('b.json', 5, [1, 3])])).not.toBe(sampleFingerprint([a, b]));
    expect(sampleFingerprint([a, gameOf('b.json', 4, [1])])).not.toBe(sampleFingerprint([a, b]));
  });

  it('воспроизведение 17.09 — совпадение до печатаемых трёх знаков', () => {
    const expected = REPRODUCE_17_09.m4;
    expect(reproduces({ mae: 1.62904, dTable: 0.4871, d2: 0.0979 }, expected)).toBe(true);
    expect(reproduces({ mae: 1.6301, dTable: 0.487, d2: 0.098 }, expected)).toBe(false);
  });
});

describe('арифметика добавки', () => {
  it('разность положительна, когда модель с добавкой ошибается меньше', () => {
    const without = ['a', 'b', 'c', 'd'].map((n) => evalOf(n, 2));
    const withIt = ['a', 'b', 'c', 'd'].map((n, i) => evalOf(n, 1.8 + i * 0.01));
    const r = additionResult(without, withIt, 1);
    expect(r.mean).toBeCloseTo(0.185, 9);
    expect(r.mde).toBeCloseTo(1.96 * r.se, 12);
    expect(r.low).toBeLessThan(r.high);
  });

  it('сдвиг прогноза на +10 п.п. силы — вес на исходной шкале признака', () => {
    const model = { means: [0, 0], sds: [1, 20], weights: [0.3, -0.5], intercept: 3.5 };
    expect(placeShiftPerTenPoints(model, 1)).toBeCloseTo(-0.25, 12);
  });
});

describe('флаг «поле узкое» и борды отложенной партии', () => {
  const board = (part: number, tavernTurn: number): FieldBoard => ({
    tavernTurn,
    part,
    turn: tavernTurn * 2 - 1,
    board: [minion(part)],
    trinketDbfIds: [],
  });

  it('считает пары, где борд отложенной партии держал поле на пороге', () => {
    // Ход 3: борды партий 1, 2, 3 — при пороге 2 без своей партии остаётся 2,
    // без своей и отложенной — 1. Ход 4: борды 1–4 — запас есть.
    const snapshot: FieldSnapshot = {
      builtAt: 'x',
      parts: [1, 2, 3, 4],
      boards: [1, 2, 3].map((p) => board(p, 3)).concat([1, 2, 3, 4].map((p) => board(p, 4))),
      damage: [],
    };
    const games = [1, 2, 3].map((part) => ({ part, game: gameOf(`p${String(part)}.json`, 3, [5, 7]) }));
    // Точки: ход таверны 3 (turn 5) и 4 (turn 7). Для каждой из шести пар
    // «отложенная × обучающая» точка хода 3 теряет поле, хода 4 — нет.
    expect(fieldFlipCount(snapshot, games, 2)).toEqual({ flips: 6, pairs: 12 });
    // Партия без фикстуры бордов не отнимает, пустой борд в счёт не идёт.
    const mixed = [
      { part: null, game: gameOf('x.json', 3, [5]) },
      { part: 1, game: gameOf('p1.json', 3, [5], false) },
    ];
    expect(fieldFlipCount(snapshot, mixed, 2)).toEqual({ flips: 0, pairs: 1 });
  });
});
