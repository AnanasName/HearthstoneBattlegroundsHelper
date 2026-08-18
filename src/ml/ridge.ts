/**
 * Гребневая (ridge) линейная регрессия в закрытой форме — вся «модель»
 * фазы 6 на сегодняшнем датасете.
 *
 * Почему так скромно: независимых исходов 23 (партии, не точки), и любая
 * модель сложнее линейной с горсткой признаков выучит имена партий.
 * Закрытая форма на 6 признаках — это решение системы 6×6, никаких
 * итераций, никакой случайности: обучение детерминировано по построению,
 * и воспроизводимость не требует зерна.
 *
 * Устройство: признаки стандартизуются по обучающей выборке (σ=0 → 1,
 * чтобы константный признак не делил на ноль), целевая центрируется,
 * веса — решение (ZᵀZ + λI)w = Zᵀy, интерсепт — среднее целевой
 * (штраф на интерсепт не кладётся, это стандарт и это важно: место 4.5
 * не «усадка к нулю»).
 */

export interface RidgeModel {
  /** Средние признаков обучающей выборки — для стандартизации на предсказании. */
  readonly means: readonly number[];
  /** Стандартные отклонения признаков; нулевые заменены единицей. */
  readonly sds: readonly number[];
  /** Веса на СТАНДАРТИЗОВАННЫХ признаках — сравнимы между собой по величине. */
  readonly weights: readonly number[];
  readonly intercept: number;
}

function columnMeans(rows: readonly (readonly number[])[], width: number): number[] {
  const sums = new Array<number>(width).fill(0);
  for (const row of rows) {
    for (let j = 0; j < width; j += 1) sums[j] = (sums[j] ?? 0) + (row[j] ?? 0);
  }
  const n = Math.max(1, rows.length);
  return sums.map((s) => s / n);
}

function columnSds(
  rows: readonly (readonly number[])[],
  means: readonly number[],
  width: number,
): number[] {
  const sums = new Array<number>(width).fill(0);
  for (const row of rows) {
    for (let j = 0; j < width; j += 1) {
      const d = (row[j] ?? 0) - (means[j] ?? 0);
      sums[j] = (sums[j] ?? 0) + d * d;
    }
  }
  const n = Math.max(1, rows.length - 1);
  return sums.map((s) => {
    const sd = Math.sqrt(s / n);
    return sd > 0 ? sd : 1;
  });
}

/**
 * Решение Ax = b гауссовым исключением с выбором главного элемента.
 * Матрица ZᵀZ + λI симметрична и при λ > 0 строго положительно определена,
 * но частичный выбор оставляет решение устойчивым и при λ = 0.
 */
function solveLinear(a: readonly (readonly number[])[], b: readonly number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = r;
    }
    const pivotRow = m[pivot];
    const colRow = m[col];
    if (pivotRow === undefined || colRow === undefined) continue;
    if (pivot !== col) {
      m[pivot] = colRow;
      m[col] = pivotRow;
    }
    const lead = m[col]?.[col] ?? 0;
    if (lead === 0) continue;
    for (let r = col + 1; r < n; r += 1) {
      const row = m[r];
      if (row === undefined) continue;
      const factor = (row[col] ?? 0) / lead;
      if (factor === 0) continue;
      for (let c = col; c <= n; c += 1) row[c] = (row[c] ?? 0) - factor * (m[col]?.[c] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r -= 1) {
    const row = m[r];
    if (row === undefined) continue;
    let s = row[n] ?? 0;
    for (let c = r + 1; c < n; c += 1) s -= (row[c] ?? 0) * (x[c] ?? 0);
    const lead = row[r] ?? 0;
    x[r] = lead === 0 ? 0 : s / lead;
  }
  return x;
}

export function fitRidge(
  rows: readonly (readonly number[])[],
  ys: readonly number[],
  lambda: number,
): RidgeModel {
  const width = rows[0]?.length ?? 0;
  const means = columnMeans(rows, width);
  const sds = columnSds(rows, means, width);
  const yMean = ys.length === 0 ? 0 : ys.reduce((a, b) => a + b, 0) / ys.length;

  // ZᵀZ и Zᵀy на стандартизованных признаках и центрированной целевой.
  const gram: number[][] = Array.from({ length: width }, () => new Array<number>(width).fill(0));
  const moment = new Array<number>(width).fill(0);
  rows.forEach((row, i) => {
    const z = row.map((v, j) => (v - (means[j] ?? 0)) / (sds[j] ?? 1));
    const dy = (ys[i] ?? 0) - yMean;
    for (let j = 0; j < width; j += 1) {
      moment[j] = (moment[j] ?? 0) + (z[j] ?? 0) * dy;
      const gj = gram[j];
      if (gj === undefined) continue;
      for (let k = j; k < width; k += 1) gj[k] = (gj[k] ?? 0) + (z[j] ?? 0) * (z[k] ?? 0);
    }
  });
  for (let j = 0; j < width; j += 1) {
    const gj = gram[j];
    if (gj === undefined) continue;
    for (let k = 0; k < j; k += 1) gj[k] = gram[k]?.[j] ?? 0;
    gj[j] = (gj[j] ?? 0) + lambda;
  }

  return { means, sds, weights: solveLinear(gram, moment), intercept: yMean };
}

export function predictRidge(model: RidgeModel, row: readonly number[]): number {
  let sum = model.intercept;
  for (let j = 0; j < model.weights.length; j += 1) {
    const z = ((row[j] ?? 0) - (model.means[j] ?? 0)) / (model.sds[j] ?? 1);
    sum += z * (model.weights[j] ?? 0);
  }
  return sum;
}

/** Место — от 1-го до 8-го; модель об этом не знает, зажим — политика места. */
export function clampPlace(value: number): number {
  return Math.min(8, Math.max(1, value));
}
