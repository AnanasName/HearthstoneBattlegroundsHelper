import { tavernTurnOf } from '../advisors/tavern/rules.js';
import { mean, percentile } from '../advisors/tavern/statAnalysis.js';
import type { GameState } from '../state/types.js';
import { extractFeatures, MISSING_PLACE } from './features.js';
import { clampPlace, fitRidge, predictRidge } from './ridge.js';
import type { DatasetGame } from './dataset.js';

/**
 * Оценка предсказания финального места — leave-one-game-out.
 *
 * Кластер — ПАРТИЯ, всегда: точки одной партии несут один исход и в разные
 * стороны кросс-валидации не разлучаются, иначе модель предсказывала бы
 * партию по её же точкам. Итоговые числа — среднее по партиям с равным
 * весом: длинная партия — это доживший до конца, то есть хорошее место,
 * и пул по точкам перекосил бы оценку к победителям.
 *
 * Всё здесь — чистые функции без файлов и печати; вход-выход и отчёт
 * живут в report.ts. Предрегистрация процедуры и критерия — docs/ml.md.
 */

/** Предрегистрированная λ основной ветки. */
export const RIDGE_LAMBDA = 1;

/** Партия в числах: признаки по точкам плюс то, что нужно бейзлайнам. */
export interface MlGame {
  readonly name: string;
  readonly finalPlace: number;
  readonly rows: readonly (readonly number[])[];
  readonly tavernTurns: readonly number[];
  /** Текущее место каждой точки — бейзлайн B1; null, если в записи его нет. */
  readonly currentPlaces: readonly (number | null)[];
}

/**
 * Извлечение признаков точки: состояние, её индекс и ВСЕ точки партии
 * по порядку — признаки по истории (замер 4) читают точки до текущей.
 * Будущего в них быть не должно; это держит тест, а не тип.
 */
export type FeatureExtractor = (
  state: GameState,
  index: number,
  states: readonly GameState[],
) => readonly number[];

/**
 * Партия в числах. Набор признаков — параметр: замер 1 считает семь
 * «своих» (`extractFeatures`), замер 3 — относительные
 * (`extractRelativeFeatures`), замер 4 — по истории
 * (`extractHistoryFeatures`). Ход таверны читается из состояния,
 * а не из первого признака: у относительного набора первый признак —
 * место, и корзины ходов с полосой D̄_late обязаны считаться одинаково
 * для любого набора.
 */
export function toMlGame(game: DatasetGame, extract: FeatureExtractor = extractFeatures): MlGame {
  const states = game.record.checkpoints.map((cp) => cp.state);
  return {
    name: game.fileName,
    finalPlace: game.finalPlace,
    rows: states.map(extract),
    tavernTurns: states.map((s) => tavernTurnOf(s.turn)),
    currentPlaces: states.map((s) => s.finalPlace),
  };
}

export interface CheckpointEval {
  readonly tavernTurn: number;
  readonly actual: number;
  readonly predicted: number;
  /** Бейзлайн B1 после подстановки: текущее место либо B0 фолда. */
  readonly currentPlace: number;
  /** Бейзлайн B0 — среднее место обучающих партий этого фолда. */
  readonly meanPlace: number;
}

export interface GameEval {
  readonly name: string;
  readonly finalPlace: number;
  readonly maeModel: number;
  readonly maeCurrent: number;
  readonly maeMean: number;
  readonly checkpoints: readonly CheckpointEval[];
}

/**
 * Нормировка признаков. Основная ветка — глобальная стандартизация внутри
 * fitRidge («identity» здесь). Вторичная («byBucket», предрегистрирована
 * как не решающая) — z-score внутри корзины ходов таверны по обучающему
 * фолду: hp=30 на 3-м ходу и на 13-м — разные вещи, и эта ветка меряет,
 * сколько стоит нестационарность.
 */
export type Normalization = 'global' | 'byBucket';

export const TURN_BUCKETS: readonly { readonly label: string; readonly from: number; readonly to: number }[] =
  [
    { label: 'ходы таверны 1–4', from: 1, to: 4 },
    { label: 'ходы таверны 5–8', from: 5, to: 8 },
    { label: 'ходы таверны 9–12', from: 9, to: 12 },
    { label: 'ходы таверны 13+', from: 13, to: Infinity },
  ];

export function bucketIndexOf(tavernTurn: number): number {
  const idx = TURN_BUCKETS.findIndex((b) => tavernTurn >= b.from && tavernTurn <= b.to);
  return idx === -1 ? TURN_BUCKETS.length - 1 : idx;
}

/** Ход таверны идёт рядом со строкой: корзина точки — не её признак. */
type Transform = (row: readonly number[], tavernTurn: number) => readonly number[];

interface ZStats {
  readonly means: readonly number[];
  readonly sds: readonly number[];
}

function zStatsOf(rows: readonly (readonly number[])[], width: number): ZStats {
  const means = new Array<number>(width).fill(0);
  for (const row of rows) {
    for (let j = 0; j < width; j += 1) means[j] = (means[j] ?? 0) + (row[j] ?? 0);
  }
  for (let j = 0; j < width; j += 1) means[j] = (means[j] ?? 0) / Math.max(1, rows.length);
  const sds = new Array<number>(width).fill(0);
  for (const row of rows) {
    for (let j = 0; j < width; j += 1) {
      const d = (row[j] ?? 0) - (means[j] ?? 0);
      sds[j] = (sds[j] ?? 0) + d * d;
    }
  }
  for (let j = 0; j < width; j += 1) {
    const sd = Math.sqrt((sds[j] ?? 0) / Math.max(1, rows.length - 1));
    sds[j] = sd > 0 ? sd : 1;
  }
  return { means, sds };
}

/** Корзина точки — по её ходу таверны, переданному рядом со строкой. */
function buildBucketTransform(
  trainRows: readonly (readonly number[])[],
  trainTurns: readonly number[],
): Transform {
  const width = trainRows[0]?.length ?? 0;
  const byBucket = new Map<number, (readonly number[])[]>();
  trainRows.forEach((row, i) => {
    const bucket = bucketIndexOf(trainTurns[i] ?? 0);
    const list = byBucket.get(bucket);
    if (list === undefined) byBucket.set(bucket, [row]);
    else list.push(row);
  });

  const stats = new Map<number, ZStats>();
  for (const [bucket, rows] of byBucket) stats.set(bucket, zStatsOf(rows, width));
  // Корзина, которой в обучении не было, z-скорится глобальной шкалой
  // фолда: сырая строка смешала бы масштабы молча — модель обучена
  // на z-скорах (docs/ml.md, «Вторичное»).
  const global = zStatsOf(trainRows, width);

  return (row, tavernTurn) => {
    const s = stats.get(bucketIndexOf(tavernTurn)) ?? global;
    return row.map((v, j) => (v - (s.means[j] ?? 0)) / (s.sds[j] ?? 1));
  };
}

const meanAbsError = (predictions: readonly number[], actual: number): number =>
  mean(predictions.map((p) => Math.abs(p - actual)));

/** LOGO: каждая партия предсказана моделью, обученной на остальных. */
export function evaluateLogo(
  games: readonly MlGame[],
  lambda: number = RIDGE_LAMBDA,
  normalization: Normalization = 'global',
): GameEval[] {
  return games.map((game) => {
    const train = games.filter((g) => g !== game);
    const transform: Transform =
      normalization === 'byBucket'
        ? buildBucketTransform(
            train.flatMap((g) => g.rows),
            train.flatMap((g) => g.tavernTurns),
          )
        : (row): readonly number[] => row;

    const trainRows: (readonly number[])[] = [];
    const trainYs: number[] = [];
    for (const g of train) {
      g.rows.forEach((row, i) => {
        trainRows.push(transform(row, g.tavernTurns[i] ?? 0));
        trainYs.push(g.finalPlace);
      });
    }
    const model = fitRidge(trainRows, trainYs, lambda);
    // B0 — по партиям, не по точкам: у длинных партий точек больше,
    // а исход у партии один.
    const meanPlace = mean(train.map((g) => g.finalPlace));

    const checkpoints = game.rows.map((row, i): CheckpointEval => {
      const predicted = clampPlace(
        predictRidge(model, transform(row, game.tavernTurns[i] ?? 0)),
      );
      return {
        tavernTurn: game.tavernTurns[i] ?? 0,
        actual: game.finalPlace,
        predicted,
        currentPlace: game.currentPlaces[i] ?? meanPlace,
        meanPlace,
      };
    });

    return {
      name: game.name,
      finalPlace: game.finalPlace,
      maeModel: meanAbsError(
        checkpoints.map((c) => c.predicted),
        game.finalPlace,
      ),
      maeCurrent: meanAbsError(
        checkpoints.map((c) => c.currentPlace),
        game.finalPlace,
      ),
      maeMean: meanAbsError(
        checkpoints.map((c) => c.meanPlace),
        game.finalPlace,
      ),
      checkpoints,
    };
  });
}

export interface EvalSummary {
  readonly maeModel: number;
  readonly maeCurrent: number;
  readonly maeMean: number;
  /** D_g = MAE_g(B1) − MAE_g(модель), по партиям; главное число — среднее. */
  readonly deltas: readonly number[];
}

/** Свод по партиям с равным весом — предрегистрированная агрегация. */
export function summarizeEvals(evals: readonly GameEval[]): EvalSummary {
  return {
    maeModel: mean(evals.map((e) => e.maeModel)),
    maeCurrent: mean(evals.map((e) => e.maeCurrent)),
    maeMean: mean(evals.map((e) => e.maeMean)),
    deltas: evals.map((e) => e.maeCurrent - e.maeModel),
  };
}

/**
 * Парные разности `D_g = MAE_g(B1) − MAE_g(модель)` по точкам с ходом
 * таверны не ниже порога — предобъявленная чувствительность раннего
 * режима (docs/ml.md): на ранних ходах место в таблице ещё лотерея,
 * и выигрыш там ожидаем; D̄_late показывает, останется ли что-нибудь
 * после первых боёв. Партии без подходящих точек выпадают и считаются.
 */
export interface LateDeltas {
  readonly deltas: readonly number[];
  readonly skippedGames: number;
}

export function lateDeltas(evals: readonly GameEval[], minTavernTurn: number): LateDeltas {
  const deltas: number[] = [];
  let skippedGames = 0;
  for (const e of evals) {
    const points = e.checkpoints.filter((c) => c.tavernTurn >= minTavernTurn);
    if (points.length === 0) {
      skippedGames += 1;
      continue;
    }
    const maeModel = mean(points.map((c) => Math.abs(c.predicted - c.actual)));
    const maeCurrent = mean(points.map((c) => Math.abs(c.currentPlace - c.actual)));
    deltas.push(maeCurrent - maeModel);
  }
  return { deltas, skippedGames };
}

export interface SignFlipBand {
  readonly p05: number;
  readonly p95: number;
}

/**
 * Полоса нуля для среднего парных разностей: знак каждой партии случаен.
 * Нулевая гипотеза — «модель и таблица неразличимы», и при ней D_g
 * симметрична вокруг нуля; 95-й перцентиль полосы — предрегистрированный
 * порог приёмки (урок cardstats: сравнивать с нулём напрямую нельзя).
 */
export function signFlipBand(
  deltas: readonly number[],
  iterations: number,
  rng: () => number,
): SignFlipBand {
  const means: number[] = [];
  for (let it = 0; it < iterations; it += 1) {
    let sum = 0;
    for (const d of deltas) sum += rng() < 0.5 ? d : -d;
    means.push(sum / Math.max(1, deltas.length));
  }
  means.sort((a, b) => a - b);
  return { p05: percentile(means, 0.05), p95: percentile(means, 0.95) };
}

/** Порог приёмки в местах — предрегистрирован (docs/ml.md). */
export const ACCEPT_THRESHOLD_PLACES = 0.25;

export type Verdict = 'ПРИНЯТЬ' | 'ОТВЕРГНУТЬ' | 'НЕ ДОКАЗАНО';

/**
 * Вердикт — дословно по предрегистрации docs/ml.md. ОТВЕРГНУТЬ — только
 * ниже 5-го перцентиля полосы: точечное D̄ ≤ 0 внутри полосы — это
 * «польза не показана», а не «таблица знает не меньше» (у таких разностей
 * нулевая точка не ноль — урок cardstats №1).
 */
export function verdictOf(
  dMean: number,
  band: SignFlipBand,
  mde: number,
  maeModel: number,
  maeMean: number,
): Verdict {
  if (dMean >= ACCEPT_THRESHOLD_PLACES && dMean > band.p95 && dMean > mde && maeModel < maeMean) {
    return 'ПРИНЯТЬ';
  }
  if (dMean < band.p05) return 'ОТВЕРГНУТЬ';
  return 'НЕ ДОКАЗАНО';
}

/**
 * Парные разности против ВТОРОЙ модели той же процедуры — для B2 (сжатое
 * место): `D₂_g = MAE_g(B2) − MAE_g(модель)`, по партиям, по имени.
 * Партия, которой у второй модели нет, берёт её B1 — этого не бывает
 * при одном списке партий, но молчать об этом тип не должен.
 */
export function pairedDeltas(evals: readonly GameEval[], other: readonly GameEval[]): number[] {
  const byName = new Map(other.map((e) => [e.name, e.maeModel]));
  return evals.map((e) => (byName.get(e.name) ?? e.maeCurrent) - e.maeModel);
}

/**
 * Вердикт замера 3 — дословно по предрегистрации docs/ml.md. Условия
 * замера 1 против таблицы (продуктовый порог, полоса, МРЭ, константа)
 * остаются все, и к ним — сигнал СВЕРХ сжатия: D̄₂ выше 95-го перцентиля
 * своей полосы и своей МРЭ. Порога в местах у D̄₂ нет намеренно:
 * продуктовый порог уже стоит у D̄, а D̄₂ отвечает на вопрос «признаки
 * или сжатие», у которого шкала — только шум. ОТВЕРГНУТЬ — и когда
 * таблица знает не меньше (D̄ ниже полосы), и когда относительные признаки
 * ХУЖЕ сжатия (D̄₂ ниже своей полосы): модель с ними проигрывает модели
 * без них.
 */
export function verdictOfRelative(
  dMean: number,
  band: SignFlipBand,
  mde: number,
  maeModel: number,
  maeMean: number,
  d2Mean: number,
  band2: SignFlipBand,
  mde2: number,
): Verdict {
  const base = verdictOf(dMean, band, mde, maeModel, maeMean);
  if (base === 'ПРИНЯТЬ' && d2Mean > band2.p95 && d2Mean > mde2) return 'ПРИНЯТЬ';
  if (dMean < band.p05 || d2Mean < band2.p05) return 'ОТВЕРГНУТЬ';
  return 'НЕ ДОКАЗАНО';
}

export interface BucketSummary {
  readonly label: string;
  readonly n: number;
  readonly maeModel: number;
  readonly maeCurrent: number;
  readonly maeMean: number;
  readonly withinOne: number;
}

/**
 * Вторичная разбивка по корзинам ходов — ПО ТОЧКАМ, не по партиям.
 * Сравнивать можно только модель против бейзлайна внутри корзины: сами
 * корзины селективны (до поздних ходов доживают в основном топ-места).
 */
export function summarizeBuckets(evals: readonly GameEval[]): BucketSummary[] {
  return TURN_BUCKETS.map((bucket, idx) => {
    const points = evals.flatMap((e) => e.checkpoints.filter((c) => bucketIndexOf(c.tavernTurn) === idx));
    return {
      label: bucket.label,
      n: points.length,
      maeModel: mean(points.map((c) => Math.abs(c.predicted - c.actual))),
      maeCurrent: mean(points.map((c) => Math.abs(c.currentPlace - c.actual))),
      maeMean: mean(points.map((c) => Math.abs(c.meanPlace - c.actual))),
      withinOne:
        points.length === 0
          ? 0
          : points.filter((c) => Math.abs(c.predicted - c.actual) <= 1).length / points.length,
    };
  });
}

export { MISSING_PLACE };
