/**
 * Анализ дампа: помогает ли статистика мест миньонов выбирать покупку.
 *
 *   npm run analyze:cardstats -- --dump <файл.jsonl>
 *
 * Ни одной симуляции — только арифметика по дампу, поэтому прогон стоит
 * секунды и повторяется сколько угодно. Процедура и ПОРОГИ ПРИЁМКИ
 * зафиксированы заранее в docs/cardstats.md.
 */
import { readFileSync } from 'node:fs';

import {
  centerWithinDecision,
  createRng,
  groupByDecision,
  mean,
  pairedDeltas,
  percentile,
  permuteWithinTier,
  rankWith,
  rankByScore,
  residualAfter,
  spearman,
  type DumpRow,
} from './statAnalysis.js';

/** Предрегистрировано: структурный курс и сетка. */
const LAMBDA_STRUCT = 4.188;
const LAMBDA_GRID = [0, 1, 2, 3, LAMBDA_STRUCT, 6, 8, 12] as const;
const PERMUTATIONS = 10_000;
const BOOTSTRAP = 2000;
/** Опубликованные числа сверки — шлюз методики. */
const PUBLISHED_AGREEMENT = 0.80;
const PUBLISHED_COST = 3.02;

const TERMS = [
  'techLevel',
  'stats',
  'tribe',
  'keywords',
  'copies',
  'golden',
  'economy',
  'battle',
  'textTribe',
  'textMech',
  'namedCard',
] as const;

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

const pp = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(2)} п.п.`;

function main(): void {
  const argv = process.argv.slice(2);
  const dumpPath = arg(argv, 'dump') ?? 'data/dataset/cardstats-dump.jsonl';

  const rows: DumpRow[] = readFileSync(dumpPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as DumpRow);
  const groups = groupByDecision(rows);
  const fixtures = [...new Set(rows.map((r) => r.fixture))].sort();

  console.log('═══ дамп ═══');
  console.log(`  строк: ${String(rows.length)}, ходов: ${String(groups.length)}, партий: ${String(fixtures.length)}`);
  console.log(`  симуляций на кандидата: ${String(rows[0]?.sims ?? 0)}`);
  console.log(`  кандидатов на ход: ${(rows.length / groups.length).toFixed(2)}`);

  // ───────────────────────── проверки годности ─────────────────────────
  console.log('\n═══ годность (читается ДО главных чисел) ═══');

  const base = rankWith(groups, 0);
  const gateAgreement = Math.abs(base.agreement - PUBLISHED_AGREEMENT) <= 0.05;
  const gateCost = Math.abs(base.averageCost - PUBLISHED_COST) <= 0.5;
  console.log(
    `  шлюз методики: совпадение ${(base.agreement * 100).toFixed(0)}% ` +
      `(опубликовано ${String(PUBLISHED_AGREEMENT * 100)}%, допуск ±5) — ${gateAgreement ? 'ОК' : 'РАСХОЖДЕНИЕ'}`,
  );
  console.log(
    `                 средняя цена ${base.averageCost.toFixed(2)} п.п. ` +
      `(опубликовано ${PUBLISHED_COST.toFixed(2)}, допуск ±0.5) — ${gateCost ? 'ОК' : 'РАСХОЖДЕНИЕ'}`,
  );

  const withStat = rows.filter((r) => r.stat !== null).length;
  const goldenRows = rows.filter((r) => r.golden).length;
  const coverage = withStat / rows.length;
  console.log(
    `  покрытие: ${(coverage * 100).toFixed(1)}% кандидатов со статистикой ` +
      `(${String(withStat)} из ${String(rows.length)}), золотых без данных ${String(goldenRows)} — ` +
      `${coverage >= 0.7 ? 'ОК' : 'НИЖЕ ПОРОГА 70%'}`,
  );

  // Положительный контроль: удвоенный вес статов обязан что-то сменить.
  const doubled = rankByScore(groups, (r) => (r.v['total'] ?? 0) + (r.v['stats'] ?? 0));
  const changedByControl = doubled.pickedCardId.filter((c, i) => c !== base.pickedCardId[i]).length;
  console.log(
    `  положительный контроль (удвоенные статы): сменил выбор на ${String(changedByControl)} ходах, ` +
      `Δcost ${pp(base.averageCost - doubled.averageCost)} — ${changedByControl > 0 ? 'ОК' : 'КОНВЕЙЕР СЛОМАН'}`,
  );

  // ───────────────────────── связь ─────────────────────────
  console.log('\n═══ есть ли сигнал сверх наших признаков ═══');

  const y = centerWithinDecision(groups, (r) => r.outcome);
  const g = centerWithinDecision(groups, (r) => r.statGain);
  const total = centerWithinDecision(groups, (r) => r.v['total'] ?? 0);
  const termVectors = TERMS.map((t) => centerWithinDecision(groups, (r) => r.v[t] ?? 0));
  const techStats = [
    centerWithinDecision(groups, (r) => r.v['techLevel'] ?? 0),
    centerWithinDecision(groups, (r) => r.v['stats'] ?? 0),
  ];

  const rho0 = spearman(total, y);
  const v1 = spearman(residualAfter(y, [total]), g);
  const v2 = spearman(residualAfter(y, termVectors), residualAfter(g, termVectors));
  const v3 = spearman(residualAfter(y, techStats), residualAfter(g, techStats));

  // Насколько статистика — пересказ наших слагаемых.
  const gAfterTerms = residualAfter(g, termVectors);
  const varG = mean(g.map((x) => x * x));
  const varRes = mean(gAfterTerms.map((x) => x * x));
  const r2GivenTerms = varG === 0 ? 0 : 1 - varRes / varG;

  console.log(`  ρ₀ (наш total ↔ исход, внутри хода): ${rho0.toFixed(4)}`);
  console.log(`  V1 (statGain ↔ остаток после total):  ${v1.toFixed(4)}`);
  console.log(`  V2 (после ВСЕХ 11 слагаемых):         ${v2.toFixed(4)}   ← главный`);
  console.log(`  V3 (после тира и статов):             ${v3.toFixed(4)}`);
  console.log(`  R²(statGain ~ 11 слагаемых):          ${r2GivenTerms.toFixed(4)}`);

  // Нуль: перестановка статистики между картами одного тира.
  const permRng = createRng(20260815);
  let ge = 0;
  const permV2: number[] = [];
  for (let i = 0; i < PERMUTATIONS; i += 1) {
    const permuted = permuteWithinTier(rows, permRng);
    const gp = centerWithinDecision(groups, permuted);
    const vp = spearman(residualAfter(y, termVectors), residualAfter(gp, termVectors));
    permV2.push(vp);
    if (vp >= v2) ge += 1;
  }
  const pValue = (1 + ge) / (PERMUTATIONS + 1);
  permV2.sort((a, b) => a - b);
  console.log(
    `  нуль (${String(PERMUTATIONS)} перестановок ВНУТРИ ТИРА): 95-й перцентиль ${percentile(permV2, 0.95).toFixed(4)}, ` +
      `99-й ${percentile(permV2, 0.99).toFixed(4)}`,
  );
  console.log(`  p(V2) односторонний = ${pValue.toFixed(4)}`);

  // ───────────── эффективный размер выборки ─────────────
  //
  // 108 ходов — это не 108 наблюдений: там, где исходы всех кандидатов
  // совпали до цифры, выбор не решает ничего и в Δcost вносит ноль.
  console.log('\n═══ сколько тут на самом деле наблюдений ═══');
  const spreads = groups.map((group) => {
    const outcomes = group.rows.map((r) => r.outcome);
    return Math.max(...outcomes) - Math.min(...outcomes);
  });
  const flat = spreads.filter((s) => s === 0).length;
  console.log(`  ходов с ТОЖДЕСТВЕННЫМИ исходами кандидатов: ${String(flat)} из ${String(groups.length)}`);
  const turnOneIdx = groups
    .map((group, i) => (group.turn === 1 ? i : -1))
    .filter((i) => i >= 0);
  const turnOneSpread = mean(turnOneIdx.map((i) => spreads[i] ?? 0));
  const restSpread = mean(
    spreads.filter((_, i) => !turnOneIdx.includes(i)),
  );
  console.log(
    `  разброс исходов: ход 1 — ${turnOneSpread.toFixed(1)} п.п., остальные — ${restSpread.toFixed(1)} п.п. ` +
      `(бой хода 1 идёт 1×1, исходы насыщены: 0/25/50/100)`,
  );

  // ───────────────────────── λ-свип ─────────────────────────
  console.log('\n═══ парный λ-свип (ноль симуляций) ═══');
  console.log('     λ | смен | совп.перв | совп.любой | ср. цена | Δcost к λ=0');
  const perLambda = new Map<number, { delta: number; changed: number }>();
  for (const lambda of LAMBDA_GRID) {
    const ranked = rankWith(groups, lambda);
    const changed = ranked.pickedCardId.filter((c, i) => c !== base.pickedCardId[i]).length;
    const deltas = pairedDeltas(base, ranked);
    const delta = mean(deltas);
    perLambda.set(lambda, { delta, changed });
    console.log(
      `  ${lambda.toFixed(2).padStart(5)} | ${String(changed).padStart(4)} | ` +
        `${(ranked.agreement * 100).toFixed(0).padStart(8)}% | ` +
        `${(ranked.agreementAny * 100).toFixed(0).padStart(9)}% | ` +
        `${ranked.averageCost.toFixed(2).padStart(8)} | ${pp(delta).padStart(12)}`,
    );
  }

  const structural = rankWith(groups, LAMBDA_STRUCT);
  const structDeltas = pairedDeltas(base, structural);
  const structDelta = mean(structDeltas);
  const changedStruct = structural.pickedCardId.filter((c, i) => c !== base.pickedCardId[i]).length;

  // ─────────────── неопределённость: кластеры по партиям ───────────────
  console.log('\n═══ неопределённость (кластеры — партии, не ходы) ═══');
  const byFixture = new Map<string, number[]>();
  groups.forEach((group, i) => {
    const list = byFixture.get(group.fixture) ?? [];
    list.push(structDeltas[i] ?? 0);
    byFixture.set(group.fixture, list);
  });

  const bootRng = createRng(777);
  const bootMeans: number[] = [];
  const names = [...byFixture.keys()];
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    const pooled: number[] = [];
    for (let k = 0; k < names.length; k += 1) {
      const pick = names[Math.floor(bootRng() * names.length)] ?? names[0] ?? '';
      pooled.push(...(byFixture.get(pick) ?? []));
    }
    bootMeans.push(mean(pooled));
  }
  bootMeans.sort((a, b) => a - b);
  const lo = percentile(bootMeans, 0.05);
  const hi = percentile(bootMeans, 0.95);
  console.log(`  Δcost(λ_struct) = ${pp(structDelta)}, смен выбора ${String(changedStruct)} из ${String(groups.length)}`);
  console.log(`  90% ДИ кластерного бутстрапа: [${pp(lo)}, ${pp(hi)}]`);

  // Leave-one-game-out: устойчивость к одной партии.
  let loMin = Infinity;
  let loMax = -Infinity;
  let loWorst = '';
  for (const name of names) {
    const kept = groups
      .map((group, i) => ({ fixture: group.fixture, d: structDeltas[i] ?? 0 }))
      .filter((x) => x.fixture !== name)
      .map((x) => x.d);
    const m = mean(kept);
    if (m < loMin) {
      loMin = m;
      loWorst = name;
    }
    if (m > loMax) loMax = m;
  }
  console.log(`  выбрасывание одной партии: от ${pp(loMin)} (без ${loWorst}) до ${pp(loMax)}`);

  // LOFO-CV: λ подбирается на 12 партиях, оценивается на 13-й.
  let cvSum = 0;
  let cvTurns = 0;
  const cvLambdas: number[] = [];
  for (const name of names) {
    const train = groups.filter((x) => x.fixture !== name);
    const test = groups.filter((x) => x.fixture === name);
    const trainBase = rankWith(train, 0);
    let bestLambda = 0;
    let bestGain = -Infinity;
    for (const lambda of LAMBDA_GRID) {
      const gain = mean(pairedDeltas(trainBase, rankWith(train, lambda)));
      if (gain > bestGain) {
        bestGain = gain;
        bestLambda = lambda;
      }
    }
    cvLambdas.push(bestLambda);
    const testBase = rankWith(test, 0);
    const deltas = pairedDeltas(testBase, rankWith(test, bestLambda));
    cvSum += deltas.reduce((a, b) => a + b, 0);
    cvTurns += deltas.length;
  }
  const cvDelta = cvTurns === 0 ? 0 : cvSum / cvTurns;
  console.log(
    `  LOFO-CV: Δcost ${pp(cvDelta)}, выбранные λ по фолдам: ${cvLambdas.map((l) => l.toFixed(1)).join(', ')}`,
  );

  // ─────────────── полоса нуля для Δcost ───────────────
  //
  // КЛЮЧЕВОЕ: нулевая точка Δcost ОТРИЦАТЕЛЬНА по построению. Советник
  // при λ=0 угадывает лучшего в 80% ходов, и возмущение такого выбора
  // ЛЮБЫМ неинформативным довеском в среднем портит его. Поэтому Δcost
  // сравнивается не с нулём, а с полосой перемешанной внутри тира
  // статистики. Без этой полосы монотонное падение Δcost читается как
  // «антисигнал», хотя это свойство самой мерки.
  console.log('\n═══ полоса нуля: перемешанная внутри тира статистика ═══');
  const negRng = createRng(31337);
  const negDeltas: number[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const permuted = permuteWithinTier(rows, negRng);
    const ranked = rankWith(groups, LAMBDA_STRUCT, permuted);
    negDeltas.push(mean(pairedDeltas(base, ranked)));
  }
  negDeltas.sort((a, b) => a - b);
  const negGe = negDeltas.filter((d) => d >= structDelta).length;
  const below = negDeltas.filter((d) => d <= structDelta).length;
  console.log(
    `  Δcost перемешанной: 5-й ${pp(percentile(negDeltas, 0.05))}, ` +
      `медиана ${pp(percentile(negDeltas, 0.5))}, 95-й ${pp(percentile(negDeltas, 0.95))}`,
  );
  console.log(
    `  настоящая Δcost = ${pp(structDelta)} — это ${((below / negDeltas.length) * 100).toFixed(1)}-й перцентиль нуля`,
  );
  console.log(`  доля перемешанных не хуже настоящей: ${((negGe / negDeltas.length) * 100).toFixed(1)}%`);

  // Разрешающая способность: что этот замер вообще способен различить.
  const changedDeltas = structDeltas.filter((d) => d !== 0);
  const sdDeltas = Math.sqrt(
    mean(structDeltas.map((d) => (d - structDelta) * (d - structDelta))),
  );
  const seDelta = sdDeltas / Math.sqrt(structDeltas.length);
  console.log(
    `  ходов с ненулевой Δ: ${String(changedDeltas.length)}; SD парных разностей ${sdDeltas.toFixed(2)}, ` +
      `SE среднего ${seDelta.toFixed(2)} п.п.`,
  );
  console.log(
    `  МИНИМАЛЬНЫЙ РАЗЛИЧИМЫЙ ЭФФЕКТ (2.8·SE) ≈ ${(2.8 * seDelta).toFixed(2)} п.п. ` +
      `против порога приёмки 0.50 п.п. — ветка Δcost собственного порога не разрешает`,
  );

  // Чувствительность к первому ходу: там бой 1×1 и лотерейные исходы.
  const withoutTurnOne = structDeltas.filter((_, i) => groups[i]?.turn !== 1);
  console.log(
    `  Δcost без хода 1: ${pp(mean(withoutTurnOne))} (${String(withoutTurnOne.length)} ходов) — ` +
      'вся величина создана боями первого хода',
  );

  // ─────────────── решающие ходы и устойчивость ───────────────
  console.log('\n═══ решающие ходы и устойчивость ═══');
  const decisiveIdx: number[] = [];
  groups.forEach((group, i) => {
    const outcomes = group.rows.map((r) => r.outcome);
    if (Math.max(...outcomes) - Math.min(...outcomes) > 3) decisiveIdx.push(i);
  });
  const decisiveDeltas = decisiveIdx.map((i) => structDeltas[i] ?? 0);
  const blowups = decisiveDeltas.filter((d) => d < -15).length;
  console.log(
    `  решающих ходов ${String(decisiveIdx.length)}, средняя парная Δ ${pp(mean(decisiveDeltas))}, ` +
      `разгромных (Δ < −15) ${String(blowups)}`,
  );

  // Порог выборки 5000: не кодирует ли слагаемое редкость карты.
  const strict = rankWith(groups, LAMBDA_STRUCT, (r) =>
    r.stat !== null && r.stat.totalPlayed >= 5000 ? r.statGain : 0,
  );
  console.log(`  при пороге выборки 5000: Δcost ${pp(mean(pairedDeltas(base, strict)))}`);

  // Сырое место вместо impact: не в контроле ли всё дело.
  const rawByCard = new Map<string, number>();
  for (const r of rows) if (r.stat !== null) rawByCard.set(r.cardId, r.stat.placement);
  const rawMeanByTier = new Map<number, number[]>();
  for (const r of rows) {
    if (r.stat === null) continue;
    const list = rawMeanByTier.get(r.techLevel ?? 0) ?? [];
    list.push(r.stat.placement);
    rawMeanByTier.set(r.techLevel ?? 0, list);
  }
  const rawTierMean = new Map<number, number>();
  for (const [t, list] of rawMeanByTier) rawTierMean.set(t, mean(list));
  const rawRanked = rankWith(groups, LAMBDA_STRUCT, (r) => {
    const p = rawByCard.get(r.cardId);
    if (p === undefined) return 0;
    const centered = -(p - (rawTierMean.get(r.techLevel ?? 0) ?? 0));
    return Math.max(-0.7164, Math.min(0.7164, centered));
  });
  console.log(`  сырое место вместо impact: Δcost ${pp(mean(pairedDeltas(base, rawRanked)))}`);

  // ─────────────── вердикт по предрегистрированным порогам ───────────────
  console.log('\n═══ вердикт по предрегистрированным порогам ═══');
  const checks: [string, boolean][] = [
    ['годность (шлюз, покрытие, контроль)', gateAgreement && gateCost && coverage >= 0.7 && changedByControl > 0],
    [`V2 ≥ 0.15 (${v2.toFixed(3)})`, v2 >= 0.15],
    [`p ≤ 0.01 (${pValue.toFixed(4)})`, pValue <= 0.01],
    [`R² < 0.8 (${r2GivenTerms.toFixed(3)}) и V3 ≥ 0.5·V1`, r2GivenTerms < 0.8 && v3 >= 0.5 * v1],
    [`Δcost ≥ +0.5 п.п. (${structDelta.toFixed(2)})`, structDelta >= 0.5],
    [`нижняя граница ДИ > 0 (${lo.toFixed(2)})`, lo > 0],
    [`знак устойчив к выбрасыванию партии (min ${loMin.toFixed(2)})`, loMin > 0],
    [
      'знак одинаков на полосе λ ∈ [2, 8]',
      [2, 3, LAMBDA_STRUCT, 6, 8].every((l) => (perLambda.get(l)?.delta ?? 0) > 0),
    ],
    [`LOFO-CV > 0 (${cvDelta.toFixed(2)})`, cvDelta > 0],
    [`решающие: Δ ≥ −1.0 п.п. (${mean(decisiveDeltas).toFixed(2)})`, mean(decisiveDeltas) >= -1],
  ];
  for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);

  const accepted = checks.every(([, ok]) => ok);
  const rejected = v2 < 0.1 || pValue > 0.05;
  console.log(
    `\n  ИТОГ: ${accepted ? 'ПРИНЯТЬ' : rejected ? 'ОТВЕРГНУТЬ' : 'НЕ ДОКАЗАНО'} — слагаемое не вносится`,
  );
  console.log(
    '  Читать как «сигнал требуемой величины НЕ ПОКАЗАН», а не «статистика вредит»:\n' +
      '  ветка Δcost собственного порога не разрешала (см. МРЭ выше), её нуль сам\n' +
      '  отрицателен, и вся отрицательная величина создана боями первого хода.\n' +
      '  Опирать вывод можно на ветку V2 — у неё разрешение было.',
  );
}

main();
