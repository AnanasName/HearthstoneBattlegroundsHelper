import type { MeasureResult } from './result.js';

/**
 * Прогоны батареи и их сравнение — чистые функции без диска и процессов.
 *
 * Сравнивать можно только прогоны с тем же зерном и тем же набором партий:
 * иначе дельта смешивает правку кода со сдвигом выборки, и это ровно
 * та ошибка, что стоила выброшенных батарей part39 и part44.
 */

export interface MeasurementRun {
  readonly exitCode: number;
  readonly durationSec: number;
  /** Итог скрипта; `null`, если скрипт упал до строки итога. */
  readonly result: MeasureResult | null;
}

export interface BatteryRun {
  readonly startedAt: string;
  readonly sha: string;
  /** Были ли незакоммиченные изменения в `src/` — такой прогон не воспроизвести. */
  readonly dirty: boolean;
  readonly seed: number;
  readonly parts: readonly number[];
  /** Прогон на полном списке партий, а не на подмножестве для проверки. */
  readonly full: boolean;
  readonly measurements: Readonly<Record<string, MeasurementRun>>;
}

/** Разброс метрик по нескольким зёрнам на одном коде. */
export interface NoiseBand {
  readonly sha: string;
  readonly seeds: readonly number[];
  readonly parts: readonly number[];
  /** Стандартное отклонение метрики по зёрнам: замер → метрика → SD. */
  readonly sd: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const sameParts = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((n, i) => n === b[i]);

export function comparable(a: BatteryRun, b: BatteryRun): boolean {
  return a.seed === b.seed && sameParts(a.parts, b.parts);
}

/** Выборочное стандартное отклонение; `null` меньше чем на двух значениях. */
export function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Полоса шума из прогонов одного кода с разными зёрнами. */
export function noiseBand(runs: readonly BatteryRun[]): NoiseBand | null {
  const first = runs[0];
  if (first === undefined || runs.length < 2) return null;
  const sd: Record<string, Record<string, number>> = {};
  for (const name of Object.keys(first.measurements)) {
    const perMetric: Record<string, number[]> = {};
    for (const run of runs) {
      const metrics = run.measurements[name]?.result?.metrics ?? {};
      for (const [key, value] of Object.entries(metrics)) {
        if (value === null) continue;
        (perMetric[key] ??= []).push(value);
      }
    }
    const row: Record<string, number> = {};
    for (const [key, values] of Object.entries(perMetric)) {
      const s = standardDeviation(values);
      if (s !== null && values.length === runs.length) row[key] = s;
    }
    sd[name] = row;
  }
  return { sha: first.sha, seeds: runs.map((r) => r.seed), parts: first.parts, sd };
}

/**
 * Три знака после запятой: у Brier score значимы тысячные (0.046 против
 * 0.079 — это целый замер part48), и два знака превращали его в ноль.
 */
const fmt = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : String(Math.round(value * 1000) / 1000);

const partsLabel = (parts: readonly number[]): string => {
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first === undefined || last === undefined) return 'нет';
  return first === last ? `1 (part${String(first)})` : `${String(parts.length)} (part${String(first)}–part${String(last)})`;
};

/** Длительность замера: секунды до полутора минут, дальше минуты. */
export function durationLabel(seconds: number): string {
  return seconds < 90 ? `${String(seconds)} с` : `${String(Math.round(seconds / 60))} мин`;
}

function runLabel(run: BatteryRun): string {
  const when = run.startedAt.replace('T', ' ').slice(0, 16);
  return `${when}, коммит ${run.sha}${run.dirty ? ' (с незакоммиченным src/)' : ''}, зерно ${String(run.seed)}, партий ${partsLabel(run.parts)}`;
}

/**
 * Вердикт строки. Без полосы шума дельта называется как есть; с полосой —
 * «в шуме», если она меньше двух стандартных отклонений по зёрнам.
 */
function verdict(delta: number | null, sd: number | undefined): string {
  if (delta === null) return '';
  if (delta === 0) return 'без изменений';
  if (sd === undefined) return 'изменилось';
  return Math.abs(delta) < 2 * sd ? 'в шуме' : 'ВНЕ шума';
}

/** Таблица для docs/measurements.md: текущий прогон против прошлого сравнимого. */
export function renderMarkdown(current: BatteryRun, previous: BatteryRun | null, noise: NoiseBand | null): string {
  const lines: string[] = [
    '# Замеры',
    '',
    'Файл генерирует `npm run battery`; руками его не правят. Сырые числа —',
    '`data/measurements/*.json`, полный вывод скриптов — `data/measurements/logs/`',
    '(не в git). В записях о партиях числа не переписываются: там стоит',
    'вердикт и ссылка сюда.',
    '',
    current.full
      ? `**Последний полный прогон:** ${runLabel(current)}.`
      : `**Прогон на подмножестве партий** (проверка правки, не итог): ${runLabel(current)}.`,
    previous === null
      ? '**Сравнимого прошлого прогона нет** — с тем же зерном и тем же набором партий.'
      : `**Сравнивается с:** ${runLabel(previous)}.`,
    noise === null
      ? '**Полосы шума нет:** `npm run battery -- --seeds=5` посчитает её один раз на коде.'
      : `**Полоса шума:** коммит ${noise.sha}, зёрна ${noise.seeds.join(', ')}; «ВНЕ шума» — дельта больше двух SD.`,
  ];

  for (const [name, run] of Object.entries(current.measurements)) {
    lines.push('', `## ${name} · ${durationLabel(run.durationSec)}`, '');
    if (run.result === null) {
      lines.push(`Скрипт не дошёл до итога (код выхода ${String(run.exitCode)}); вывод — в логе прогона.`);
      continue;
    }
    const before = previous?.measurements[name]?.result?.metrics ?? null;
    const sdRow = noise?.sd[name] ?? {};
    lines.push('| метрика | было | стало | Δ | шум (SD) | |', '|---|---:|---:|---:|---:|---|');
    for (const [key, value] of Object.entries(run.result.metrics)) {
      const old = before === null ? null : (before[key] ?? null);
      const delta = value === null || old === null ? null : Math.round((value - old) * 1000) / 1000;
      lines.push(
        `| ${key} | ${fmt(old)} | ${fmt(value)} | ${fmt(delta)} | ${fmt(sdRow[key])} | ${verdict(delta, sdRow[key])} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
