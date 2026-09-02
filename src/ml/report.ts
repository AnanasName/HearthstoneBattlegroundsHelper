import { createRng, mean, shuffleInPlace, summarize } from '../advisors/tavern/statAnalysis.js';
import type { GameState } from '../state/types.js';
import { extractFeatures, FEATURE_NAMES } from './features.js';
import { extractHistoryFeatures, HISTORY_FEATURE_NAMES } from './historyFeatures.js';
import {
  extractRelativeFeatures,
  lobbyKnownInState,
  RELATIVE_FEATURE_NAMES,
  RELATIVE_PLACE_INDEX,
} from './relativeFeatures.js';
import { fitRidge } from './ridge.js';
import {
  evaluateLogo,
  lateDeltas,
  pairedDeltas,
  RIDGE_LAMBDA,
  signFlipBand,
  summarizeBuckets,
  summarizeEvals,
  toMlGame,
  verdictOf,
  verdictOfRelative,
  type FeatureExtractor,
  type MlGame,
} from './evaluate.js';
import { loadDataset } from './dataset.js';
import {
  filterGames,
  formatProvenance,
  parseDatasetFilter,
  type DatasetFilter,
} from './provenance.js';

/**
 * Отчёт фазы 6: предсказание финального места против таблицы лидеров.
 *
 *   npm run ml:eval     — замер 1: семь «своих» признаков
 *   npm run ml:eval3    — замер 3: относительные признаки (против стола)
 *   npm run ml:eval4    — замер 4: те же плюс признаки по истории партии
 *
 * Процедура и критерий приёмки каждого замера предрегистрированы
 * в docs/ml.md ДО первого прогона; этот скрипт только считает и называет
 * вердикт по записанным условиям. Решает ОСНОВНАЯ ветка (λ=1, глобальная
 * стандартизация, LOGO по партиям); всё остальное — печать для сведения.
 * Набор признаков — параметр (`--features=…`), процедура одна: замеры 3
 * и 4 отличаются от замера 1 признаками, зёрнами, исключением партий
 * без таблицы лобби и вторым условием приёмки — сигналом сверх сжатия B2.
 * Замер 4 печатает ещё и разность с моделью замера 3 (B3) — она
 * не решает, а отвечает, добавила ли история что-нибудь к одной точке.
 */

interface FeatureSet {
  readonly key: 'own' | 'relative' | 'history';
  readonly title: string;
  readonly names: readonly string[];
  readonly extract: FeatureExtractor;
  /** Модель-предшественник для вторичной разности D̄₃ (замер 4 против замера 3). */
  readonly predecessor: { readonly title: string; readonly extract: FeatureExtractor; readonly bandSeed: number } | null;
  /** Индекс признака «текущее место» — единственного признака бейзлайна B2. */
  readonly placeIndex: number;
  /** Зёрна — предрегистрированы: полоса sign-flip и отрицательный контроль. */
  readonly bandSeed: number;
  readonly controlSeed: number;
  /** Зерно полосы D̄₂ — только у замера с условием «сигнал сверх сжатия». */
  readonly band2Seed: number | null;
  /** Партии без таблицы лобби хотя бы в одной точке исключаются целиком. */
  readonly requiresLobby: boolean;
}

const OWN_FEATURES: FeatureSet = {
  key: 'own',
  title: 'замер 1 — семь «своих» признаков',
  names: FEATURE_NAMES,
  extract: extractFeatures,
  placeIndex: 3,
  bandSeed: 20260818,
  controlSeed: 20260819,
  band2Seed: null,
  requiresLobby: false,
  predecessor: null,
};

const RELATIVE_FEATURES: FeatureSet = {
  key: 'relative',
  title: 'замер 3 — относительные признаки против стола',
  names: RELATIVE_FEATURE_NAMES,
  extract: extractRelativeFeatures,
  placeIndex: RELATIVE_PLACE_INDEX,
  bandSeed: 20260829,
  controlSeed: 20260830,
  band2Seed: 20260831,
  requiresLobby: true,
  predecessor: null,
};

const HISTORY_FEATURES: FeatureSet = {
  key: 'history',
  title: 'замер 4 — относительные признаки плюс история партии',
  names: HISTORY_FEATURE_NAMES,
  extract: extractHistoryFeatures,
  placeIndex: RELATIVE_PLACE_INDEX,
  bandSeed: 20260901,
  controlSeed: 20260902,
  band2Seed: 20260903,
  requiresLobby: true,
  predecessor: {
    title: 'B3 (модель замера 3, относительные признаки)',
    extract: extractRelativeFeatures,
    bandSeed: 20260904,
  },
};

/** Вторичная ветка замера 3: семь «своих» плюс четыре относительных (место — один раз). */
const COMBINED_NAMES: readonly string[] = [...FEATURE_NAMES, ...RELATIVE_FEATURE_NAMES.slice(1)];
const extractCombined = (state: GameState): readonly number[] => [
  ...extractFeatures(state),
  ...extractRelativeFeatures(state).slice(1),
];

const BAND_ITERATIONS = 10_000;
/** Ранний режим: D̄_late считается по точкам с хода таверны ≥ 5. */
const LATE_FROM_TAVERN_TURN = 5;
/** Контроль: модель на перемешанных местах лучше B0 больше этого — утечка. */
const CONTROL_LEAK_THRESHOLD = 0.1;

const fmt = (x: number): string => x.toFixed(3);

function featureSetFromArgs(argv: readonly string[]): FeatureSet {
  const arg = argv.find((a) => a.startsWith('--features='));
  if (arg === undefined) return OWN_FEATURES;
  const key = arg.slice('--features='.length);
  if (key === 'relative') return RELATIVE_FEATURES;
  if (key === 'history') return HISTORY_FEATURES;
  if (key === 'own') return OWN_FEATURES;
  throw new Error(`неизвестный набор признаков: ${key} (own | relative | history)`);
}

function main(featureSet: FeatureSet, filter: DatasetFilter): void {
  const data = loadDataset();

  console.log(`билд: ${String(data.build ?? 'неизвестен')}`);
  for (const line of formatProvenance(data.games, filter)) console.log(line);
  for (const dup of data.duplicates) {
    console.log(`задвоено: оставлено ${dup.kept}, отброшено ${dup.dropped.join(', ')}`);
  }
  for (const f of data.droppedOtherBuild) console.log(`чужой билд, отброшено: ${f}`);
  for (const f of data.droppedUnusable) console.log(`без места или точек, отброшено: ${f}`);

  const selected = filterGames(data.games, filter);
  let usable = selected;
  if (featureSet.requiresLobby) {
    // Относительные признаки на пустой таблице — не пропуск, а ложь;
    // партия без таблицы хотя бы в одной точке выпадает целиком.
    usable = selected.filter((g) => g.record.checkpoints.every((cp) => lobbyKnownInState(cp.state)));
    for (const g of selected) {
      if (!usable.includes(g)) console.log(`без таблицы лобби, исключено: ${g.fileName}`);
    }
  }

  const games = usable.map((g) => toMlGame(g, featureSet.extract));
  const points = games.reduce((n, g) => n + g.rows.length, 0);
  const placeCounts = new Map<number, number>();
  for (const g of games) placeCounts.set(g.finalPlace, (placeCounts.get(g.finalPlace) ?? 0) + 1);
  const placesLine = [...placeCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([p, n]) => `${String(p)}-е ×${String(n)}`)
    .join(', ');
  console.log(
    `партий: ${String(games.length)}, точек решения: ${String(points)}, места: ${placesLine}`,
  );

  if (games.length < 5) {
    console.log('партий меньше пяти — кросс-валидация по партиям бессмысленна, стоп.');
    return;
  }

  // ПРОВЕРКА ГОДНОСТИ — читается до главных чисел: отрицательный контроль
  // конвейера. Места перемешиваются между партиями; модели учиться
  // не на чем, и она обязана выйти не лучше B0 своего прогона.
  const shuffledPlaces = shuffleInPlace(
    games.map((g) => g.finalPlace),
    createRng(featureSet.controlSeed),
  );
  const shuffledGames: MlGame[] = games.map((g, i) => ({
    ...g,
    finalPlace: shuffledPlaces[i] ?? g.finalPlace,
  }));
  const control = summarizeEvals(evaluateLogo(shuffledGames, RIDGE_LAMBDA, 'global'));
  const leak = control.maeMean - control.maeModel;
  console.log('');
  console.log(
    `годность — отрицательный контроль (перемешанные места): ` +
      `модель ${fmt(control.maeModel)} против B0 ${fmt(control.maeMean)}, разность ${fmt(leak)}`,
  );
  if (leak > CONTROL_LEAK_THRESHOLD) {
    console.log(
      `ПРОГОН НЕДЕЙСТВИТЕЛЕН: на перемешанных местах модель лучше B0 ` +
        `на ${fmt(leak)} > ${String(CONTROL_LEAK_THRESHOLD)} — в конвейере утечка.`,
    );
    return;
  }

  // ОСНОВНАЯ ветка — предрегистрированная.
  const evals = evaluateLogo(games, RIDGE_LAMBDA, 'global');
  const summary = summarizeEvals(evals);
  const deltaStats = summarize(summary.deltas);
  const band = signFlipBand(summary.deltas, BAND_ITERATIONS, createRng(featureSet.bandSeed));
  const mde = 1.645 * deltaStats.se;

  console.log('');
  console.log(
    `— основная ветка: ${featureSet.title}; LOGO, λ=${String(RIDGE_LAMBDA)}, глобальная стандартизация —`,
  );
  console.log(
    `MAE по партиям:  модель ${fmt(summary.maeModel)}  | таблица (B1) ${fmt(summary.maeCurrent)}  | среднее место (B0) ${fmt(summary.maeMean)}`,
  );
  console.log(
    `D̄ = MAE(B1) − MAE(модель) = ${fmt(deltaStats.mean)} места ` +
      `(SE ${fmt(deltaStats.se)}, МРЭ ${fmt(mde)}, партий с |D|>0.05: ${String(deltaStats.moved)} из ${String(deltaStats.n)})`,
  );
  console.log(
    `полоса sign-flip (${String(BAND_ITERATIONS)} перестановок): 5-й ${fmt(band.p05)} … 95-й ${fmt(band.p95)}`,
  );

  // Предобъявленная чувствительность: ранний режим.
  const late = lateDeltas(evals, LATE_FROM_TAVERN_TURN);
  const lateStats = summarize(late.deltas);
  console.log(
    `D̄_late (ходы таверны ≥ ${String(LATE_FROM_TAVERN_TURN)}): ${fmt(lateStats.mean)} ` +
      `(SE ${fmt(lateStats.se)}, партий ${String(lateStats.n)}, выпало ${String(late.skippedGames)})`,
  );

  // B2 — сжатое место: та же процедура на единственном признаке таблицы.
  const placeOnly: MlGame[] = games.map((g) => ({
    ...g,
    rows: g.rows.map((row) => [row[featureSet.placeIndex] ?? 0]),
  }));
  const b2Evals = evaluateLogo(placeOnly, RIDGE_LAMBDA, 'global');
  const d2 = pairedDeltas(evals, b2Evals);
  const d2Stats = summarize(d2);
  console.log(
    `B2 (сжатое место, только признак таблицы): MAE ${fmt(mean(b2Evals.map((e) => e.maeModel)))}, ` +
      `D̄₂ = MAE(B2) − MAE(модель) = ${fmt(d2Stats.mean)}`,
  );

  let verdict = verdictOf(deltaStats.mean, band, mde, summary.maeModel, summary.maeMean);
  if (featureSet.band2Seed !== null) {
    // Замер 3: сигнал СВЕРХ сжатия — своя полоса и своя МРЭ у D̄₂.
    const band2 = signFlipBand(d2, BAND_ITERATIONS, createRng(featureSet.band2Seed));
    const mde2 = 1.645 * d2Stats.se;
    console.log(
      `  D̄₂: SE ${fmt(d2Stats.se)}, МРЭ₂ ${fmt(mde2)}, полоса sign-flip 5-й ${fmt(band2.p05)} … 95-й ${fmt(band2.p95)}, ` +
        `партий с |D₂|>0.05: ${String(d2Stats.moved)} из ${String(d2Stats.n)}`,
    );
    verdict = verdictOfRelative(
      deltaStats.mean,
      band,
      mde,
      summary.maeModel,
      summary.maeMean,
      d2Stats.mean,
      band2,
      mde2,
    );
  }
  console.log(`вердикт по предрегистрированному критерию: ${verdict}`);

  if (featureSet.predecessor !== null) {
    // Вторичное, предобъявленное чтение: добавила ли история что-нибудь
    // к модели с одной точки. Не решает — вердикт выше уже назван.
    const pred = featureSet.predecessor;
    const predEvals = evaluateLogo(
      usable.map((g) => toMlGame(g, pred.extract)),
      RIDGE_LAMBDA,
      'global',
    );
    const d3 = pairedDeltas(evals, predEvals);
    const d3Stats = summarize(d3);
    const band3 = signFlipBand(d3, BAND_ITERATIONS, createRng(pred.bandSeed));
    console.log(
      `${pred.title}: MAE ${fmt(mean(predEvals.map((e) => e.maeModel)))}, ` +
        `D̄₃ = MAE(B3) − MAE(модель) = ${fmt(d3Stats.mean)} ` +
        `(SE ${fmt(d3Stats.se)}, МРЭ₃ ${fmt(1.645 * d3Stats.se)}, полоса 5-й ${fmt(band3.p05)} … 95-й ${fmt(band3.p95)})`,
    );
  }

  console.log('');
  console.log('— по корзинам ходов (по точкам; сравнивать только внутри корзины) —');
  for (const b of summarizeBuckets(evals)) {
    console.log(
      `${b.label}: n=${String(b.n)}  модель ${fmt(b.maeModel)} | B1 ${fmt(b.maeCurrent)} | B0 ${fmt(b.maeMean)} | ` +
        `|ошибка|≤1: ${(b.withinOne * 100).toFixed(0)}%`,
    );
  }
  const allPoints = evals.flatMap((e) => e.checkpoints);
  const withinOneAll =
    allPoints.filter((c) => Math.abs(c.predicted - c.actual) <= 1).length /
    Math.max(1, allPoints.length);
  console.log(`доля точек с |ошибка|≤1 места (все точки, модель): ${(withinOneAll * 100).toFixed(0)}%`);

  console.log('');
  console.log('— вторичное (не решает) —');
  for (const lambda of [0, 0.3, 1, 3, 10]) {
    const s = summarizeEvals(evaluateLogo(games, lambda, 'global'));
    console.log(`λ=${String(lambda)}: MAE модели ${fmt(s.maeModel)}, D̄ ${fmt(mean(s.deltas))}`);
  }
  const byBucket = summarizeEvals(evaluateLogo(games, RIDGE_LAMBDA, 'byBucket'));
  console.log(
    `нормировка внутри корзин: MAE модели ${fmt(byBucket.maeModel)}, D̄ ${fmt(mean(byBucket.deltas))}`,
  );
  if (featureSet.key === 'relative') {
    // Семь «своих» плюс относительные: показывает, добавляют ли абсолютные
    // признаки что-нибудь к относительным, — печать, не решение.
    const combined = usable.map((g) => toMlGame(g, extractCombined));
    const combinedEvals = evaluateLogo(combined, RIDGE_LAMBDA, 'global');
    const cs = summarizeEvals(combinedEvals);
    console.log(
      `семь «своих» + относительные (${String(COMBINED_NAMES.length)} признаков): ` +
        `MAE модели ${fmt(cs.maeModel)}, D̄ ${fmt(mean(cs.deltas))}, D̄₂ ${fmt(mean(pairedDeltas(combinedEvals, b2Evals)))}`,
    );
  }

  const full = fitRidge(
    games.flatMap((g) => g.rows),
    games.flatMap((g) => g.rows.map(() => g.finalPlace)),
    RIDGE_LAMBDA,
  );
  console.log('');
  console.log('веса модели на всех партиях (стандартизованные признаки):');
  featureSet.names.forEach((name, i) => {
    console.log(`  ${name}: ${fmt(full.weights[i] ?? 0)}`);
  });
  console.log(`  интерсепт: ${fmt(full.intercept)}`);
}

main(featureSetFromArgs(process.argv.slice(2)), parseDatasetFilter(process.argv.slice(2)));
