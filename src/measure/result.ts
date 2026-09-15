/**
 * Итог замера одной строкой, которую читает раннер батареи.
 *
 * Скрипт печатает таблицы для человека как раньше, а в конце — строку
 * с префиксом и JSON. Так скрипты остаются самостоятельными командами,
 * а числа перестают переписываться из терминала в документацию руками:
 * их забирает `npm run battery` и кладёт в `data/measurements/`.
 */

export const RESULT_PREFIX = 'BATTERY-RESULT ';

/** Число метрики; `null` — посчитать было не на чем (например, ноль ходов). */
export type Metrics = Readonly<Record<string, number | null>>;

export interface MeasureResult {
  readonly seed: number | null;
  readonly parts: readonly number[] | null;
  readonly metrics: Metrics;
}

export function emitResult(result: MeasureResult): void {
  console.log(RESULT_PREFIX + JSON.stringify(result));
}

/** Последняя строка итога в выводе; `null`, если скрипт её не напечатал. */
export function parseResult(stdout: string): MeasureResult | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith(RESULT_PREFIX));
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  return JSON.parse(last.slice(RESULT_PREFIX.length)) as MeasureResult;
}

/** Число, округлённое до `digits` знаков, или `null`, если числа нет. */
export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}
