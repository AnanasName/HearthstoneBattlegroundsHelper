import { describe, expect, it } from 'vitest';

import { createRng } from '../../src/advisors/tavern/statAnalysis.js';
import {
  bucketIndexOf,
  evaluateLogo,
  lateDeltas,
  pairedDeltas,
  signFlipBand,
  summarizeBuckets,
  summarizeEvals,
  toMlGame,
  verdictOf,
  verdictOfRelative,
  type CheckpointEval,
  type GameEval,
  type MlGame,
} from '../../src/ml/evaluate.js';
import type { DatasetGame } from '../../src/ml/dataset.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Оценка LOGO: кластер — партия, бейзлайны — константа и таблица.
 * Синтетика здесь намеренно точная: где связь линейна и без шума,
 * кросс-валидация обязана выучить её до нуля ошибки — всё, что больше
 * нуля, было бы утечкой или багом арифметики.
 */

/** Партия из трёх точек: второй признак — само место, остальные — шум. */
function syntheticGame(name: string, place: number): MlGame {
  const junk = [0.3, 0.9, 0.1];
  return {
    name,
    finalPlace: place,
    rows: junk.map((j, i) => [i + 1, place, j]),
    tavernTurns: junk.map((_, i) => i + 1),
    currentPlaces: junk.map(() => null),
  };
}

describe('оценка LOGO', () => {
  it('точная линейная связь выучивается до нуля ошибки', () => {
    const games = [1, 2, 3, 4, 5, 6, 7, 8].map((p) => syntheticGame(`g${String(p)}`, p));
    const summary = summarizeEvals(evaluateLogo(games, 0));
    expect(summary.maeModel).toBeLessThan(1e-6);
    // Константный бейзлайн на тех же партиях честно ошибается.
    expect(summary.maeMean).toBeGreaterThan(1);
  });

  it('пропуск текущего места подставляет B0 обучающего фолда', () => {
    const games = [1, 3, 5, 7].map((p) => syntheticGame(`g${String(p)}`, p));
    const evals = evaluateLogo(games, 0);
    const first = evals[0];
    // Фолд партии с местом 1 учится на местах 3, 5, 7 → B0 = 5.
    expect(first?.checkpoints[0]?.meanPlace).toBe(5);
    expect(first?.checkpoints[0]?.currentPlace).toBe(5);
    expect(first?.maeCurrent).toBe(4);
  });

  it('текущее место, когда оно есть, и становится бейзлайном B1', () => {
    const games = [1, 3, 5, 7].map((p) => syntheticGame(`g${String(p)}`, p));
    const withPlaces: MlGame = { ...syntheticGame('seen', 2), currentPlaces: [4, 2, null] };
    const evals = evaluateLogo([withPlaces, ...games], 0);
    const target = evals[0];
    expect(target?.checkpoints.map((c) => c.currentPlace)).toEqual([4, 2, 4]);
    expect(target?.maeCurrent).toBeCloseTo((2 + 0 + 2) / 3, 9);
  });

  it('toMlGame переносит место, признаки и текущее место из записи', () => {
    const state: GameState = {
      ...EMPTY_STATE,
      phase: 'tavern',
      turn: 5,
      techLevel: 2,
      finalPlace: 6,
      board: board([1], { attack: 2, health: 3 }),
    };
    const game: DatasetGame = {
      fileName: 'x.json',
      finalPlace: 3,
      record: {
        savedAt: '2026-08-18T00:00:00.000Z',
        buildNumber: 248348,
        heroCardId: 'H',
        finalPlace: 3,
        checkpoints: [{ turn: 5, state }],
      },
    };
    const ml = toMlGame(game);
    expect(ml.finalPlace).toBe(3);
    expect(ml.tavernTurns).toEqual([3]);
    expect(ml.currentPlaces).toEqual([6]);
    expect(ml.rows[0]?.[1]).toBe(2);

    // Набор признаков — параметр, а ход таверны читается из состояния,
    // не из первого признака: у относительного набора первый — место.
    const relative = toMlGame(game, (s) => [s.finalPlace ?? 0, 42]);
    expect(relative.rows).toEqual([[6, 42]]);
    expect(relative.tavernTurns).toEqual([3]);
  });

  it('парные разности против второй модели считаются по имени партии', () => {
    const evalOf = (name: string, maeModel: number, maeCurrent: number): GameEval => ({
      name,
      finalPlace: 1,
      maeModel,
      maeCurrent,
      maeMean: 0,
      checkpoints: [],
    });
    const d2 = pairedDeltas(
      [evalOf('a', 1.0, 3.0), evalOf('b', 2.0, 3.0)],
      [evalOf('b', 2.5, 0), evalOf('a', 1.2, 0)],
    );
    expect(d2[0]).toBeCloseTo(0.2, 12);
    expect(d2[1]).toBeCloseTo(0.5, 12);
  });

  it('вердикт замера 3 — условия замера 1 плюс сигнал сверх сжатия', () => {
    const band = { p05: -0.3, p95: 0.2 };
    const band2 = { p05: -0.1, p95: 0.08 };
    // Всё взято: и против таблицы, и против сжатого места.
    expect(verdictOfRelative(0.4, band, 0.1, 1.0, 1.5, 0.12, band2, 0.09)).toBe('ПРИНЯТЬ');
    // Против таблицы взято, а сверх сжатия — только шум: не доказано.
    expect(verdictOfRelative(0.4, band, 0.1, 1.0, 1.5, 0.05, band2, 0.09)).toBe('НЕ ДОКАЗАНО');
    expect(verdictOfRelative(0.4, band, 0.1, 1.0, 1.5, 0.085, band2, 0.09)).toBe('НЕ ДОКАЗАНО');
    // Относительные признаки ХУЖЕ сжатия — отвергнуть, даже при выигрыше у таблицы.
    expect(verdictOfRelative(0.4, band, 0.1, 1.0, 1.5, -0.15, band2, 0.09)).toBe('ОТВЕРГНУТЬ');
    // Таблица знает не меньше — отвергнуть, как в замере 1.
    expect(verdictOfRelative(-0.5, band, 0.1, 1.5, 1.4, 0.0, band2, 0.09)).toBe('ОТВЕРГНУТЬ');
    // Минус внутри обеих полос — не доказано.
    expect(verdictOfRelative(-0.1, band, 0.1, 1.5, 1.4, -0.05, band2, 0.09)).toBe('НЕ ДОКАЗАНО');
  });

  it('полоса sign-flip детерминирована зерном и накрывает ноль', () => {
    const deltas = [0.3, -0.2, 0.5, -0.1, 0.2, 0.15, -0.4, 0.05];
    const first = signFlipBand(deltas, 2000, createRng(7));
    const second = signFlipBand(deltas, 2000, createRng(7));
    expect(first).toEqual(second);
    expect(first.p05).toBeLessThan(0);
    expect(first.p95).toBeGreaterThan(0);
  });

  it('корзины ходов таверны разложены по границам', () => {
    expect(bucketIndexOf(1)).toBe(0);
    expect(bucketIndexOf(4)).toBe(0);
    expect(bucketIndexOf(5)).toBe(1);
    expect(bucketIndexOf(12)).toBe(2);
    expect(bucketIndexOf(13)).toBe(3);
    expect(bucketIndexOf(25)).toBe(3);
  });

  it('свод по корзинам делит точки, не партии', () => {
    const games = [2, 4, 6].map((p) => syntheticGame(`g${String(p)}`, p));
    const buckets = summarizeBuckets(evaluateLogo(games, 0));
    // Все синтетические точки — ходы 1..3, первая корзина.
    expect(buckets[0]?.n).toBe(9);
    expect(buckets[1]?.n).toBe(0);
    expect(buckets[0]?.withinOne).toBe(1);
  });

  it('обучение пулит точки с равным весом точки — записанное решение', () => {
    // Все признаки константны: модель может выучить только интерсепт,
    // а он — среднее целевой ПО ТОЧКАМ обучающего фолда.
    const flat = (name: string, place: number, points: number): MlGame => ({
      name,
      finalPlace: place,
      rows: Array.from({ length: points }, () => [1, 0, 0]),
      tavernTurns: Array.from({ length: points }, () => 1),
      currentPlaces: Array.from({ length: points }, () => null),
    });
    const held = flat('held', 4, 2);
    const evals = evaluateLogo([held, flat('long', 2, 4), flat('short', 6, 1)], 1);
    // Пул по точкам: (2×4 + 6×1)/5 = 2.8; по партиям было бы 4.
    expect(evals[0]?.checkpoints[0]?.predicted).toBeCloseTo(2.8, 9);
    // B0 при этом — по партиям: (2 + 6)/2 = 4.
    expect(evals[0]?.checkpoints[0]?.meanPlace).toBe(4);
  });

  it('byBucket: корзина, отсутствующая в обучении, нормируется глобальной шкалой фолда', () => {
    // Обучающие партии живут только в корзине 1–4; у вынесенной партии
    // точка в корзине 13+. Признак №2 — точное место: с глобальным
    // z-скором фолда линейная связь доезжает до предсказания точно,
    // сырая строка дала бы шкалу вразнобой и промах на несколько мест.
    const train = [2, 4, 6].map(
      (p): MlGame => ({
        name: `t${String(p)}`,
        finalPlace: p,
        rows: [1, 2, 3].map((t) => [t, p, 0.5]),
        tavernTurns: [1, 2, 3],
        currentPlaces: [null, null, null],
      }),
    );
    const held: MlGame = {
      name: 'late',
      finalPlace: 1,
      rows: [[13, 1, 0.5]],
      tavernTurns: [13],
      currentPlaces: [null],
    };
    const evals = evaluateLogo([held, ...train], 0, 'byBucket');
    expect(evals[0]?.maeModel).toBeLessThan(1e-6);
  });

  it('вердикт — дословно по предрегистрации, включая «минус внутри полосы»', () => {
    const band = { p05: -0.3, p95: 0.2 };
    expect(verdictOf(0.4, band, 0.1, 1.0, 1.5)).toBe('ПРИНЯТЬ');
    // Ниже 5-го перцентиля полосы — таблица знает не меньше.
    expect(verdictOf(-0.5, band, 0.1, 1.5, 1.4)).toBe('ОТВЕРГНУТЬ');
    // Отрицательное, но внутри полосы — «польза не показана», не «хуже».
    expect(verdictOf(-0.1, band, 0.1, 1.5, 1.4)).toBe('НЕ ДОКАЗАНО');
    // Выше нуля, но ниже порога или МРЭ — тоже не доказано.
    expect(verdictOf(0.2, band, 0.1, 1.0, 1.5)).toBe('НЕ ДОКАЗАНО');
    expect(verdictOf(0.3, band, 0.35, 1.0, 1.5)).toBe('НЕ ДОКАЗАНО');
    // Порог и полоса взяты, но модель не лучше константы — не доказано.
    expect(verdictOf(0.4, band, 0.1, 1.6, 1.5)).toBe('НЕ ДОКАЗАНО');
  });

  it('D̄_late считает только поздние точки и называет выпавшие партии', () => {
    const cp = (
      tavernTurn: number,
      predicted: number,
      currentPlace: number,
      actual: number,
    ): CheckpointEval => ({ tavernTurn, actual, predicted, currentPlace, meanPlace: 0 });
    const evalOf = (name: string, checkpoints: CheckpointEval[]): GameEval => ({
      name,
      finalPlace: 1,
      maeModel: 0,
      maeCurrent: 0,
      maeMean: 0,
      checkpoints,
    });
    const late = lateDeltas(
      [
        // Ранняя точка (ход 1) в D̄_late не входит; поздняя даёт 3 − 1 = 2.
        evalOf('a', [cp(1, 3, 1, 1), cp(5, 2, 4, 1)]),
        evalOf('onlyEarly', [cp(1, 3, 1, 1)]),
      ],
      5,
    );
    expect(late.deltas).toEqual([2]);
    expect(late.skippedGames).toBe(1);
  });
});
