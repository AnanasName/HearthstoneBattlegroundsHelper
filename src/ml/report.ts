import { createRng, mean, shuffleInPlace, summarize } from '../advisors/tavern/statAnalysis.js';
import { FEATURE_NAMES } from './features.js';
import { fitRidge } from './ridge.js';
import {
  evaluateLogo,
  lateDeltas,
  RIDGE_LAMBDA,
  signFlipBand,
  summarizeBuckets,
  summarizeEvals,
  toMlGame,
  verdictOf,
  type MlGame,
} from './evaluate.js';
import { loadDataset } from './dataset.js';

/**
 * Отчёт фазы 6: предсказание финального места против таблицы лидеров.
 *
 *   npm run ml:eval
 *
 * Процедура и критерий приёмки предрегистрированы в docs/ml.md ДО первого
 * прогона; этот скрипт только считает и называет вердикт по записанным
 * условиям. Решает ОСНОВНАЯ ветка (λ=1, глобальная стандартизация,
 * LOGO по партиям); всё остальное — печать для сведения.
 */

/** Зёрна — предрегистрированы: полоса sign-flip и отрицательный контроль. */
const BAND_SEED = 20260818;
const CONTROL_SEED = 20260819;
const BAND_ITERATIONS = 10_000;
/** Ранний режим: D̄_late считается по точкам с хода таверны ≥ 5. */
const LATE_FROM_TAVERN_TURN = 5;
/** Контроль: модель на перемешанных местах лучше B0 больше этого — утечка. */
const CONTROL_LEAK_THRESHOLD = 0.1;
/** Индекс признака «текущее место» — единственный признак бейзлайна B2. */
const PLACE_FEATURE_INDEX = 3;

const fmt = (x: number): string => x.toFixed(3);

function main(): void {
  const data = loadDataset();

  console.log(`билд: ${String(data.build ?? 'неизвестен')}`);
  for (const dup of data.duplicates) {
    console.log(`задвоено: оставлено ${dup.kept}, отброшено ${dup.dropped.join(', ')}`);
  }
  for (const f of data.droppedOtherBuild) console.log(`чужой билд, отброшено: ${f}`);
  for (const f of data.droppedUnusable) console.log(`без места или точек, отброшено: ${f}`);

  const games = data.games.map(toMlGame);
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
    createRng(CONTROL_SEED),
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
  const band = signFlipBand(summary.deltas, BAND_ITERATIONS, createRng(BAND_SEED));
  const mde = 1.645 * deltaStats.se;

  console.log('');
  console.log(`— основная ветка: LOGO, λ=${String(RIDGE_LAMBDA)}, глобальная стандартизация —`);
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

  // Предобъявленное чтение B2: сжатое место против полной модели.
  const placeOnly: MlGame[] = games.map((g) => ({
    ...g,
    rows: g.rows.map((row) => [row[PLACE_FEATURE_INDEX] ?? 0]),
  }));
  const b2Evals = evaluateLogo(placeOnly, RIDGE_LAMBDA, 'global');
  const b2ByName = new Map(b2Evals.map((e) => [e.name, e.maeModel]));
  const d2 = evals.map((e) => (b2ByName.get(e.name) ?? e.maeCurrent) - e.maeModel);
  console.log(
    `B2 (сжатое место, только признак таблицы): MAE ${fmt(mean(b2Evals.map((e) => e.maeModel)))}, ` +
      `D̄₂ = MAE(B2) − MAE(модель) = ${fmt(mean(d2))}`,
  );

  const verdict = verdictOf(deltaStats.mean, band, mde, summary.maeModel, summary.maeMean);
  console.log(`вердикт по предрегистрированному критерию: ${verdict}`);

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

  const full = fitRidge(
    games.flatMap((g) => g.rows),
    games.flatMap((g) => g.rows.map(() => g.finalPlace)),
    RIDGE_LAMBDA,
  );
  console.log('');
  console.log('веса модели на всех партиях (стандартизованные признаки):');
  FEATURE_NAMES.forEach((name, i) => {
    console.log(`  ${name}: ${fmt(full.weights[i] ?? 0)}`);
  });
  console.log(`  интерсепт: ${fmt(full.intercept)}`);
}

main();
