import { describe, expect, it } from 'vitest';

import { clampPlace, fitRidge, predictRidge } from '../../src/ml/ridge.js';

/**
 * Гребневая регрессия в закрытой форме — арифметика, на которой стоит
 * весь замер фазы 6. Проверяется поведением, а не внутренностями:
 * точное восстановление линейной связи при λ=0, стягивание к среднему
 * при большой λ, устойчивость к вырожденному признаку.
 */

/** Точная линейная зависимость: y = 3 + 2a − 1.5b, без шума. */
const ROWS: readonly (readonly number[])[] = [
  [1, 2],
  [2, 1],
  [3, 5],
  [4, 2],
  [5, 7],
  [6, 1],
  [7, 4],
  [8, 8],
];
const YS = ROWS.map((r) => 3 + 2 * (r[0] ?? 0) - 1.5 * (r[1] ?? 0));

describe('гребневая регрессия', () => {
  it('λ=0 восстанавливает точную линейную связь', () => {
    const model = fitRidge(ROWS, YS, 0);
    ROWS.forEach((row, i) => {
      expect(predictRidge(model, row)).toBeCloseTo(YS[i] ?? 0, 9);
    });
    // И вне обучающих точек: связь выучена, а не запомнена.
    expect(predictRidge(model, [10, 3])).toBeCloseTo(3 + 20 - 4.5, 9);
  });

  it('большая λ стягивает предсказание к среднему целевой', () => {
    const model = fitRidge(ROWS, YS, 1e9);
    const yMean = YS.reduce((a, b) => a + b, 0) / YS.length;
    expect(predictRidge(model, [1, 2])).toBeCloseTo(yMean, 3);
    expect(predictRidge(model, [8, 8])).toBeCloseTo(yMean, 3);
  });

  it('константный признак получает нулевой вес и не валит решение', () => {
    const rows = ROWS.map((r) => [...r, 5]);
    const model = fitRidge(rows, YS, 0);
    expect(model.weights[2]).toBe(0);
    rows.forEach((row, i) => {
      expect(predictRidge(model, row)).toBeCloseTo(YS[i] ?? 0, 9);
    });
  });

  it('λ между крайностями сжимает веса монотонно', () => {
    const loose = fitRidge(ROWS, YS, 0);
    const tight = fitRidge(ROWS, YS, 10);
    const norm = (ws: readonly number[]): number => ws.reduce((a, w) => a + w * w, 0);
    expect(norm(tight.weights)).toBeLessThan(norm(loose.weights));
  });

  it('зажим места держит [1, 8]', () => {
    expect(clampPlace(0.2)).toBe(1);
    expect(clampPlace(9.7)).toBe(8);
    expect(clampPlace(4.5)).toBe(4.5);
  });
});
