import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { createBattleSimulator } from '../advisors/battle/simulator.js';
import { loadFieldBoards } from '../advisors/strength/boards.js';
import { DEFAULT_FIELD_STRENGTH_OPTIONS } from '../advisors/strength/strength.js';
import { tavernTurnOf } from '../advisors/tavern/rules.js';
import { createRng, mean, shuffleInPlace, summarize } from '../advisors/tavern/statAnalysis.js';
import { CURRENT_BUILD_PARTS } from '../data/fixtureGames.js';
import { loadDataset, recordKey, type DatasetGame } from './dataset.js';
import {
  bucketIndexOf,
  evaluateLogo,
  fitOnGames,
  pairedDeltas,
  RIDGE_LAMBDA,
  signFlipBand,
  summarizeBuckets,
  summarizeEvals,
  toMlGame,
  TURN_BUCKETS,
  verdictOfAddition,
  verdictOfRelative,
  type ExtraWeighting,
  type FeatureExtractor,
  type GameEval,
  type MlGame,
  type Verdict,
} from './evaluate.js';
import { extractHistoryFeatures, HISTORY_FEATURE_NAMES } from './historyFeatures.js';
import { LOBBY_FEATURE_NAMES, toLobbyMlGame, type LobbyMlGame } from './lobbyRows.js';
import {
  additionResult,
  applyLabelCorrections,
  CONTROL_LEAK_THRESHOLD,
  fieldFlipCount,
  mappingProblems,
  measure6Sample,
  MDE_Z_M4,
  placeShiftPerTenPoints,
  REPRODUCE_17_09,
  reproduces,
  sampleFingerprint,
  SEED,
  BAND_ITERATIONS,
  type AdditionResult,
  type ReproTarget,
} from './measure6.js';
import { filterGames, formatProvenance, parseDatasetFilter } from './provenance.js';
import {
  extractRelativeFeatures,
  lobbyKnownInState,
  RELATIVE_FEATURE_NAMES,
  RELATIVE_PLACE_INDEX,
} from './relativeFeatures.js';
import { clampPlace, predictRidge } from './ridge.js';
import {
  buildFixtureIndex,
  gameStrengths,
  indicatorExtractor,
  INDICATOR_FEATURE_NAMES,
  partOfGame,
  STRENGTH_CACHE_PATH,
  STRENGTH_FEATURE_NAMES,
  StrengthCache,
  strengthExtractor,
  strengthStamp,
  type StrengthPoint,
} from './strengthFeature.js';

/**
 * Замер 6 фазы 6: соперники из лобби (6а) и сила стола (6б).
 *
 *   npm run ml:eval6 -- --fresh   — прогон с пересчётом силы (так делаются оба прогона вердикта)
 *   npm run ml:eval6              — сила из кэша (чтение после вердикта)
 *
 * Процедура, пороги, зёрна и последствия предрегистрированы в docs/ml.md
 * («Замер 6») ДО первого прогона; решающая арифметика и проверки
 * годности — в `measure6.ts` под тестами. Решают две строки «вердикт 6а»
 * и «вердикт 6б»; остальное — печать для сведения.
 */

const fmt = (x: number): string => x.toFixed(3);

function codeStamp(): string {
  try {
    const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain -- src package.json package-lock.json', { encoding: 'utf8' }).trim();
    return `${head}${dirty === '' ? '' : '+грязное'}`;
  } catch {
    return 'без-git';
  }
}

function simulatorVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('@firestone-hs/simulate-bgs-battle/package.json') as { version: string }).version;
}

function placesLine(games: readonly MlGame[]): string {
  const counts = new Map<number, number>();
  for (const g of games) counts.set(g.finalPlace, (counts.get(g.finalPlace) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([p, n]) => `${String(p)}-е ×${String(n)}`)
    .join(', ');
}

function logo(games: readonly MlGame[], weighting: ExtraWeighting = 'row'): GameEval[] {
  return evaluateLogo(games, RIDGE_LAMBDA, 'global', weighting);
}

interface Criterion {
  readonly mae: number;
  readonly maeMean: number;
  readonly dTable: number;
  readonly d2: number;
  readonly verdict: Verdict;
  readonly line: string;
}

/** Критерий замеров 3–4 для модели: против таблицы и сверх сжатия B2, как в `report.ts`. */
function criterionOf(
  evals: readonly GameEval[],
  placeOnly: readonly MlGame[],
  tableSeed: number,
  b2Seed: number,
): Criterion {
  const s = summarizeEvals(evals);
  const table = summarize(s.deltas);
  const tableBand = signFlipBand(s.deltas, BAND_ITERATIONS, createRng(tableSeed));
  const d2 = pairedDeltas(evals, logo(placeOnly));
  const d2Stats = summarize(d2);
  const band2 = signFlipBand(d2, BAND_ITERATIONS, createRng(b2Seed));
  const verdict = verdictOfRelative(
    table.mean,
    tableBand,
    MDE_Z_M4 * table.se,
    s.maeModel,
    s.maeMean,
    d2Stats.mean,
    band2,
    MDE_Z_M4 * d2Stats.se,
  );
  return {
    mae: s.maeModel,
    maeMean: s.maeMean,
    dTable: table.mean,
    d2: d2Stats.mean,
    verdict,
    line:
      `против таблицы D̄ ${fmt(table.mean)} (МРЭ ${fmt(MDE_Z_M4 * table.se)}, 95-й ${fmt(tableBand.p95)}), ` +
      `сверх сжатия D̄₂ ${fmt(d2Stats.mean)} (МРЭ₂ ${fmt(MDE_Z_M4 * d2Stats.se)}, 95-й ${fmt(band2.p95)}) → ${verdict}`,
  };
}

const placeOnlyOf = (games: readonly MlGame[]): MlGame[] =>
  games.map((g) => ({
    name: g.name,
    finalPlace: g.finalPlace,
    rows: g.rows.map((row) => [row[RELATIVE_PLACE_INDEX] ?? 0]),
    tavernTurns: g.tavernTurns,
    currentPlaces: g.currentPlaces,
  }));

/** Отрицательный контроль: места партий перемешаны, модели учиться не на чем. */
function controlLeak(
  games: readonly MlGame[],
  weighting: ExtraWeighting = 'row',
): { model: number; mean: number; leak: number } {
  const c = summarizeEvals(logo(games, weighting));
  return { model: c.maeModel, mean: c.maeMean, leak: c.maeMean - c.maeModel };
}

function printAddition(label: string, r: AdditionResult): void {
  console.log(
    `${label} = ${fmt(r.mean)} места (SE ${fmt(r.se)}, МРЭ(1.96) ${fmt(r.mde)}, ` +
      `полоса 2.5-й ${fmt(r.low)} … 97.5-й ${fmt(r.high)}, партий с |D|>0.05: ` +
      `${String(r.deltas.filter((d) => Math.abs(d) > 0.05).length)} из ${String(r.deltas.length)})`,
  );
}

function printPaired(label: string, without: readonly GameEval[], withIt: readonly GameEval[]): void {
  const s = summarize(pairedDeltas(withIt, without));
  console.log(`${label}: ${fmt(s.mean)} (SE ${fmt(s.se)})`);
}

/** Та же парная разность, но только по точкам с ходом таверны не ниже порога. */
function lateAddition(without: readonly GameEval[], withIt: readonly GameEval[], minTurn: number): number[] {
  const byName = new Map(without.map((e) => [e.name, e]));
  const deltas: number[] = [];
  for (const e of withIt) {
    const base = byName.get(e.name);
    if (base === undefined) continue;
    const a = base.checkpoints.filter((c) => c.tavernTurn >= minTurn);
    const b = e.checkpoints.filter((c) => c.tavernTurn >= minTurn);
    if (a.length === 0) continue;
    deltas.push(
      mean(a.map((c) => Math.abs(c.predicted - c.actual))) - mean(b.map((c) => Math.abs(c.predicted - c.actual))),
    );
  }
  return deltas;
}

function printBuckets(title: string, a: readonly GameEval[], b: readonly GameEval[], aName: string, bName: string): void {
  console.log(title);
  const sb = summarizeBuckets(b);
  summarizeBuckets(a).forEach((x, i) => {
    const y = sb[i];
    if (y === undefined) return;
    console.log(
      `  ${x.label}: n=${String(x.n)}  ${aName} ${fmt(x.maeModel)} | ${bName} ${fmt(y.maeModel)} | ` +
        `B1 ${fmt(x.maeCurrent)} | B0 ${fmt(x.maeMean)}`,
    );
  });
}

function printWeights(names: readonly string[], games: readonly MlGame[], weighting: ExtraWeighting = 'row'): void {
  const model = fitOnGames(games, RIDGE_LAMBDA, weighting);
  names.forEach((name, i) => {
    console.log(`  ${name}: ${fmt(model.weights[i] ?? 0)}`);
  });
  console.log(`  интерсепт: ${fmt(model.intercept)}`);
}

/**
 * Вторичное 6а: модель на точных исходах соперников отложенной партии.
 * Выборка смещена (точны почти одни выбывшие раньше нас), поэтому
 * сравнивать можно только модель с таблицей на одних и тех же строках.
 */
function opponentExactMae(games: readonly LobbyMlGame[]): { model: number; table: number; games: number } {
  const perGame: { model: number; table: number }[] = [];
  for (const game of games) {
    const idx = game.extraExact.flatMap((exact, i) => (exact ? [i] : []));
    if (idx.length === 0) continue;
    const model = fitOnGames(
      games.filter((g) => g !== game),
      RIDGE_LAMBDA,
      'balanced',
    );
    const errs = idx.map((i) => {
      const y = game.extraYs?.[i] ?? 0;
      const pred = clampPlace(predictRidge(model, game.extraRows?.[i] ?? []));
      return { model: Math.abs(pred - y), table: Math.abs((game.extraCurrentPlaces[i] ?? 0) - y) };
    });
    perGame.push({ model: mean(errs.map((e) => e.model)), table: mean(errs.map((e) => e.table)) });
  }
  return {
    model: mean(perGame.map((g) => g.model)),
    table: mean(perGame.map((g) => g.table)),
    games: perGame.length,
  };
}

function lobbyGamesOf(
  games: readonly DatasetGame[],
  options: Parameters<typeof toLobbyMlGame>[1] = {},
): LobbyMlGame[] {
  return games.flatMap((g) => {
    const r = toLobbyMlGame(g, options);
    return r.ok ? [r.game] : [];
  });
}

function measureLobby(usable: readonly DatasetGame[]): Verdict | null {
  console.log('');
  console.log('═══ замер 6а — соперники из таблицы лобби как обучающие строки ═══');

  const kept: DatasetGame[] = [];
  const lobbyGames: LobbyMlGame[] = [];
  for (const g of usable) {
    const r = toLobbyMlGame(g);
    if (r.ok) {
      kept.push(g);
      lobbyGames.push(r.game);
    } else {
      console.log(`годность исходов не сошлась, исключено из 6а: ${g.fileName} — ${r.reason}`);
    }
  }
  if (lobbyGames.length < 5) {
    console.log('партий меньше пяти — стоп.');
    return null;
  }

  const ownGames = kept.map((g) => toMlGame(g, extractRelativeFeatures));
  const extraRows = lobbyGames.reduce((n, g) => n + (g.extraRows?.length ?? 0), 0);
  const exactRows = lobbyGames.reduce((n, g) => n + g.extraExact.filter(Boolean).length, 0);
  console.log(
    `партий ${String(lobbyGames.length)}, своих точек ${String(ownGames.reduce((n, g) => n + g.rows.length, 0))}, ` +
      `строк соперников ${String(extraRows)} (с точным исходом ${String(exactRows)}, со средним группы ${String(extraRows - exactRows)})`,
  );
  console.log(`места владельца: ${placesLine(ownGames)}`);

  // Контроль: места владельца перемешаны, исходы доживших соперников
  // выведены от ПЕРЕМЕШАННОГО места. Утечку строк отложенной партии этот
  // контроль не видит (они несли бы истинное место) — её держит тест
  // `evaluateLogo` («строки отложенной партии… в обучение не попадают»).
  const shuffled = shuffleInPlace(
    kept.map((g) => g.finalPlace),
    createRng(SEED.controlA),
  );
  const cOwn = controlLeak(ownGames.map((g, i) => ({ ...g, finalPlace: shuffled[i] ?? g.finalPlace })));
  const cLobby = controlLeak(
    kept.flatMap((g, i) => {
      const r = toLobbyMlGame(g, { ownerPlace: shuffled[i] ?? g.finalPlace });
      return r.ok ? [r.game] : [];
    }),
    'balanced',
  );
  console.log(
    `годность — отрицательный контроль: A0 ${fmt(cOwn.model)} против B0 ${fmt(cOwn.mean)} (разность ${fmt(cOwn.leak)}); ` +
      `A1 ${fmt(cLobby.model)} против B0 ${fmt(cLobby.mean)} (разность ${fmt(cLobby.leak)})`,
  );
  if (cOwn.leak > CONTROL_LEAK_THRESHOLD || cLobby.leak > CONTROL_LEAK_THRESHOLD) {
    console.log(`ПРОГОН 6а НЕДЕЙСТВИТЕЛЕН: разность контроля выше ${String(CONTROL_LEAK_THRESHOLD)} — в конвейере утечка.`);
    return null;
  }

  const evalsA0 = logo(ownGames);
  const evalsA1 = logo(lobbyGames, 'balanced');
  const sA0 = summarizeEvals(evalsA0);
  const sA1 = summarizeEvals(evalsA1);
  console.log('');
  console.log('— основная ветка: A0 (замер 3 на своих точках) против A1 (те же признаки на всех восьми, вес поровну) —');
  console.log(
    `MAE по партиям: A0 ${fmt(sA0.maeModel)} | A1 ${fmt(sA1.maeModel)} | ` +
      `таблица (B1) ${fmt(sA0.maeCurrent)} | среднее место (B0) ${fmt(sA0.maeMean)}`,
  );
  const r = additionResult(evalsA0, evalsA1, SEED.bandA);
  printAddition('D̄_L = MAE(A0) − MAE(A1)', r);
  const verdict = verdictOfAddition(r.mean, { low: r.low, high: r.high }, r.mde, true);
  console.log(`вердикт 6а по предрегистрированному критерию: ${verdict}`);

  console.log('');
  console.log('— вторичное 6а (не решает) —');
  const placeOnly = placeOnlyOf(ownGames);
  const b2 = logo(placeOnly);
  const d2 = summarize(pairedDeltas(evalsA1, b2));
  const dTable = summarize(sA1.deltas);
  console.log(`A1 против таблицы: D̄ ${fmt(dTable.mean)} (SE ${fmt(dTable.se)}); против сжатого места B2: D̄₂ ${fmt(d2.mean)} (SE ${fmt(d2.se)})`);
  if (verdict === 'ПРИНЯТЬ' && d2.mean <= 0) {
    console.log('  предобъявленное чтение: выигрыш A1 дало сжатие места к среднему, а не соперники.');
  }
  printPaired('A1 с равным весом строки: D̄ = MAE(A0) − MAE(A1-строка)', evalsA0, logo(lobbyGames, 'row'));
  printPaired(
    'A1 с исходами доживших по текущему месту: D̄ к A0',
    evalsA0,
    logo(lobbyGamesOf(kept, { survivors: 'currentOrder' }), 'balanced'),
  );
  printPaired('A1 только на точных исходах (смещено отбором): D̄ к A0', evalsA0, logo(lobbyGamesOf(kept, { exactOnly: true }), 'balanced'));
  const m4 = logo(kept.map((g) => toMlGame(g, extractHistoryFeatures)));
  printPaired(
    `против модели замера 4 (MAE ${fmt(mean(m4.map((e) => e.maeModel)))}): D̄ = MAE(модель 4) − MAE(A1)`,
    m4,
    evalsA1,
  );
  const opp = opponentExactMae(lobbyGames);
  console.log(
    `точные исходы соперников отложенной партии (${String(opp.games)} партий): A1 ${fmt(opp.model)} | таблица ${fmt(opp.table)}`,
  );
  printBuckets('по корзинам ходов (по точкам владельца):', evalsA0, evalsA1, 'A0', 'A1');
  console.log('веса A1 (стандартизованные признаки):');
  printWeights(LOBBY_FEATURE_NAMES, lobbyGames, 'balanced');
  console.log('веса A0:');
  printWeights(RELATIVE_FEATURE_NAMES, ownGames);
  return verdict;
}

function measureStrength(
  usable: readonly DatasetGame[],
  fresh: boolean,
  code: string,
  simVersion: string,
): Verdict | null {
  console.log('');
  console.log('═══ замер 6б — сила стола как признак модели замера 4 ═══');
  const snapshot = loadFieldBoards();
  if (snapshot === null) {
    console.log('снапшота поля нет — сначала `npm run field:fit`; стоп.');
    return null;
  }
  const options = DEFAULT_FIELD_STRENGTH_OPTIONS;
  console.log(
    `поле: ${String(snapshot.boards.length)} бордов, собрано ${snapshot.builtAt}, ` +
      `sha1 ${createHash('sha1').update(JSON.stringify(snapshot.boards)).digest('hex')}; ` +
      `симуляций на борд ${String(options.simulations)}, порог поля ${String(options.minBoards)}, ` +
      `пакет симулятора ${simVersion}`,
  );

  // ГОДНОСТЬ СОПОСТАВЛЕНИЯ — до счёта силы: несопоставленная партия
  // считалась бы против поля с бордами собственных соперников.
  const cache = new StrengthCache(STRENGTH_CACHE_PATH, fresh);
  const index = cache.fixtureIndex(CURRENT_BUILD_PARTS, () => buildFixtureIndex(CURRENT_BUILD_PARTS));
  const fieldParts = new Set(snapshot.boards.map((b) => b.part));
  const parts = new Map<string, number | null>();
  const byPart = new Map<number, string[]>();
  const unmapped: string[] = [];
  const ambiguous: string[] = [];
  const notInField = new Set<number>();
  for (const g of usable) {
    const part = partOfGame(g, index);
    parts.set(g.fileName, part);
    if (part === null) {
      unmapped.push(g.fileName);
      // Номера нет ни в записи, ни в имени (`partOfGame` проверил оба), и
      // первая точка у неё общая с двумя фикстурами.
      if (index.ambiguous.has(recordKey(g.record))) ambiguous.push(g.fileName);
      continue;
    }
    byPart.set(part, [...(byPart.get(part) ?? []), g.fileName]);
    if (!fieldParts.has(part)) notInField.add(part);
  }
  const problems = mappingProblems({
    unmapped,
    byPart,
    ambiguous,
    notInField: [...notInField],
    missingLogs: index.missing,
  });
  console.log(
    `сопоставлено с фикстурой: ${String(usable.length - unmapped.length)} партий; без фикстуры: ` +
      `${unmapped.length === 0 ? 'нет' : unmapped.join(', ')}`,
  );
  if (problems.length > 0) {
    for (const p of problems) console.log(`годность: ${p}`);
    console.log('ПРОГОН 6б НЕДЕЙСТВИТЕЛЕН: сопоставление с фикстурами не сошлось — возможна утечка своих бордов в поле.');
    return null;
  }

  const flips = fieldFlipCount(
    snapshot,
    usable.map((g) => ({ part: parts.get(g.fileName) ?? null, game: g })),
    options.minBoards,
  );
  console.log(
    `флаг «поле узкое» сменили бы борды отложенной партии в ${String(flips.flips)} парах из ${String(flips.pairs)} ` +
      `(обучающая точка × отложенная партия)`,
  );
  const withCounters = usable.reduce(
    (n, g) =>
      n + g.record.checkpoints.filter((cp) => Object.values(cp.state.globalInfo).some((v) => v !== null && v !== undefined)).length,
    0,
  );
  console.log(`своих счётчиков боя в точках: ${String(withCounters)} — в замере обнулены у всех (D205)`);

  const simulator = createBattleSimulator();
  const stamp = strengthStamp(snapshot, options, code, simVersion);
  const points = new Map<string, readonly StrengthPoint[]>();
  for (const g of usable) {
    const part = parts.get(g.fileName) ?? null;
    const started = Date.now();
    const list = cache.strengths(g, part, stamp, () => gameStrengths(g, part, snapshot, simulator, options));
    points.set(g.fileName, list);
    console.error(
      `${g.fileName}: part${part === null ? '—' : String(part)}, точек ${String(list.length)}, ${String(Date.now() - started)} мс`,
    );
  }
  const coverage = TURN_BUCKETS.map((b, idx) => {
    let value = 0;
    let board = 0;
    let field = 0;
    for (const g of usable) {
      const list = points.get(g.fileName) ?? [];
      g.record.checkpoints.forEach((cp, i) => {
        if (bucketIndexOf(tavernTurnOf(cp.state.turn)) !== idx) return;
        const p = list[i];
        if (p === 'board') board += 1;
        else if (p === 'field') field += 1;
        else value += 1;
      });
    }
    return `${b.label}: сила ${String(value)}, борд пуст ${String(board)}, поле узкое ${String(field)}`;
  });
  console.log(`покрытие: ${coverage.join('; ')}`);

  const extract = (make: (p: readonly StrengthPoint[]) => FeatureExtractor): MlGame[] =>
    usable.map((g) => toMlGame(g, make(points.get(g.fileName) ?? [])));
  const gamesB0 = extract(indicatorExtractor);
  const gamesB1 = extract(strengthExtractor);
  const gamesM4 = usable.map((g) => toMlGame(g, extractHistoryFeatures));

  const shuffled = shuffleInPlace(
    gamesB1.map((g) => g.finalPlace),
    createRng(SEED.controlB),
  );
  const c = controlLeak(gamesB1.map((g, i) => ({ ...g, finalPlace: shuffled[i] ?? g.finalPlace })));
  console.log(
    `годность — отрицательный контроль: B1 ${fmt(c.model)} против B0-константы ${fmt(c.mean)}, разность ${fmt(c.leak)} ` +
      `(утечку через признак он не видит — её держит проверка сопоставления выше)`,
  );
  if (c.leak > CONTROL_LEAK_THRESHOLD) {
    console.log(`ПРОГОН 6б НЕДЕЙСТВИТЕЛЕН: разность контроля выше ${String(CONTROL_LEAK_THRESHOLD)} — в конвейере утечка.`);
    return null;
  }

  const evalsB0 = logo(gamesB0);
  const evalsB1 = logo(gamesB1);
  const evalsM4 = logo(gamesM4);
  const prerequisite = criterionOf(evalsB1, placeOnlyOf(gamesB1), SEED.tableB, SEED.b2B);

  console.log('');
  console.log('— основная ветка: B0 (замер 4 + флаги «борд пуст», «поле узкое») против B1 (то же + значение силы) —');
  console.log(
    `MAE по партиям: B0 ${fmt(summarizeEvals(evalsB0).maeModel)} | B1 ${fmt(prerequisite.mae)} | ` +
      `модель замера 4 ${fmt(summarizeEvals(evalsM4).maeModel)} | таблица ${fmt(summarizeEvals(evalsB1).maeCurrent)} | ` +
      `среднее место ${fmt(prerequisite.maeMean)}`,
  );
  console.log(`предварительное условие (критерий замера 4 для B1): ${prerequisite.line}`);
  const r = additionResult(evalsB0, evalsB1, SEED.bandB);
  printAddition('D̄_S = MAE(B0) − MAE(B1)', r);
  const verdict = verdictOfAddition(r.mean, { low: r.low, high: r.high }, r.mde, prerequisite.verdict === 'ПРИНЯТЬ');
  console.log(`вердикт 6б по предрегистрированному критерию: ${verdict}`);
  if (verdict !== 'ПРИНЯТЬ' && r.mean > r.high && r.mean > r.mde) {
    console.log(
      '  предобъявленное чтение: значение силы несёт сигнал сверх флагов, но B1 не берёт критерий замера 4 — ' +
        'строка прогноза не переводится, шаг 4 не открывается.',
    );
  }

  console.log('');
  console.log('— вторичное 6б (не решает) —');
  printPaired('флаги без значения против модели замера 4: D̄ = MAE(модель 4) − MAE(B0)', evalsM4, evalsB0);
  printPaired('B1 против модели замера 4: D̄ = MAE(модель 4) − MAE(B1)', evalsM4, evalsB1);
  const late = summarize(lateAddition(evalsB0, evalsB1, 5));
  console.log(`D̄_S по ходам таверны ≥ 5: ${fmt(late.mean)} (SE ${fmt(late.se)}, партий ${String(late.n)})`);
  printBuckets('по корзинам ходов:', evalsB0, evalsB1, 'B0', 'B1');
  const shift = placeShiftPerTenPoints(fitOnGames(gamesB1), HISTORY_FEATURE_NAMES.length);
  console.log(
    `+10 п.п. силы на входе в ход сдвигают прогноз места на ${fmt(shift)} ` +
      '(сила до покупок; на силу после покупок это не переносится)',
  );
  console.log('веса B1 (стандартизованные признаки):');
  printWeights(STRENGTH_FEATURE_NAMES, gamesB1);
  console.log('веса B0:');
  printWeights(INDICATOR_FEATURE_NAMES, gamesB0);
  return verdict;
}

function main(): void {
  const argv = process.argv.slice(2);
  const fresh = argv.includes('--fresh');
  const filter = parseDatasetFilter(argv);
  const code = codeStamp();
  const simVersion = simulatorVersion();
  console.log(`код: ${code}; сила ${fresh ? 'пересчитывается' : 'из кэша, где он годен'}`);

  const data = loadDataset();
  console.log(`билд: ${String(data.build ?? 'неизвестен')}`);
  for (const line of formatProvenance(data.games, filter)) console.log(line);
  for (const dup of data.duplicates) {
    console.log(`задвоено: оставлено ${dup.kept}, отброшено ${dup.dropped.join(', ')}`);
  }
  for (const f of data.droppedOtherBuild) console.log(`чужой билд, отброшено: ${f}`);
  for (const f of data.droppedUnusable) console.log(`без места или точек, отброшено: ${f}`);

  const selected = filterGames(data.games, filter);
  const usable = selected.filter((g) => g.record.checkpoints.every((cp) => lobbyKnownInState(cp.state)));
  for (const g of selected) {
    if (!usable.includes(g)) console.log(`без таблицы лобби, исключено: ${g.fileName}`);
  }
  const points = usable.reduce((n, g) => n + g.record.checkpoints.length, 0);
  console.log(
    `партий: ${String(usable.length)}, точек решения: ${String(points)}, отпечаток выборки ${sampleFingerprint(usable)}`,
  );

  // ГОДНОСТЬ ПРИБОРА — до поправок меток: A0 и модель замера 4 обязаны
  // воспроизвести числа перезамера 17.09 на тех же партиях.
  const reproduce = (
    extract: FeatureExtractor,
    expected: ReproTarget,
    label: string,
  ): boolean => {
    const games = usable.map((g) => toMlGame(g, extract));
    const evals = logo(games);
    const s = summarizeEvals(evals);
    const actual = {
      mae: s.maeModel,
      dTable: mean(s.deltas),
      d2: mean(pairedDeltas(evals, logo(placeOnlyOf(games)))),
    };
    const ok = reproduces(actual, expected);
    console.log(
      `годность — ${label} воспроизводит 17.09: MAE ${fmt(actual.mae)}, D̄ ${fmt(actual.dTable)}, D̄₂ ${fmt(actual.d2)} → ${ok ? 'да' : 'НЕТ'}`,
    );
    return ok;
  };
  const okM3 = reproduce(extractRelativeFeatures, REPRODUCE_17_09.m3, 'модель замера 3');
  const okM4 = reproduce(extractHistoryFeatures, REPRODUCE_17_09.m4, 'модель замера 4');
  if (!okM3 || !okM4) {
    console.log('ПРОГОН НЕДЕЙСТВИТЕЛЕН: прибор не воспроизводит прежние числа — считает не то же, что замеры 3 и 4.');
    return;
  }

  // Выборка замера 6 — предрегистрирована: без двойников фикстур,
  // без невозможных точек, с известной поправкой метки.
  const sample = measure6Sample(usable);
  for (const line of sample.dropped) console.log(`исключено (предрегистрировано): ${line}`);
  const corrected = applyLabelCorrections(sample.games);
  for (const line of corrected.applied) console.log(`поправка метки (предрегистрирована): ${line}`);
  console.log(
    `выборка замера 6: партий ${String(corrected.games.length)}, точек ` +
      `${String(corrected.games.reduce((n, g) => n + g.record.checkpoints.length, 0))}, ` +
      `отпечаток ${sampleFingerprint(corrected.games)}`,
  );

  const a = measureLobby(corrected.games);
  const b = measureStrength(corrected.games, fresh, code, simVersion);
  console.log('');
  console.log(`ИТОГ: 6а — ${a ?? 'не посчитан'}; 6б — ${b ?? 'не посчитан'}`);
}

main();
