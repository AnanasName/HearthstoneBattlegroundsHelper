/**
 * Проверка плана трат хода перебором корзин.
 *
 *   npm run validate:spend
 *   npm run validate:spend -- --parts=4-7 --seed=2
 *
 * Отвечает на вопрос, отложенный в CLAUDE.md: довольно ли жадной цепочки
 * правил или нужен полный оптимизатор трат. Устройство и оговорки —
 * в spendQuality.ts, числа и выводы — в docs/tavern.md.
 *
 * Симулятор сеяный — см. `seededSimulator` и `validate.ts`.
 */
import { seededSimulator } from '../battle/seeded.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { loadCardIndex } from '../../data/cards.js';
import { partsArg, seedArg } from '../../measure/args.js';
import { emitResult, round } from '../../measure/result.js';
import { readShards, shardInArg, shardOutArg, writeShard } from '../../measure/shard.js';
import {
  averageGoldLeft,
  measureSpendQuality,
  spendAgreement,
  spendCost,
  type SpendComparison,
} from './spendQuality.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';

const FIXTURES = partsArg(process.argv, CURRENT_BUILD_PARTS);
const SEED = seedArg(process.argv);

/** Граница «внутри выборки / вне её» — см. пояснение в `validate.ts`. */
const IN_SAMPLE_UNTIL = 26;

/**
 * Собранное по партиям — сырьё, из которого считаются метрики.
 *
 * Едет между процессами как JSON: в `SpendComparison` одни числа и флаги,
 * поэтому запись и чтение куска строку не меняют. Метрики по этому сырью
 * считает `summarize` — один и тот же код и при прогоне подряд, и при склейке.
 */
interface Collected {
  all: SpendComparison[];
  decisive: SpendComparison[];
  sameShape: SpendComparison[];
  inSample: SpendComparison[];
  outOfSample: SpendComparison[];
  skippedNoBattle: number;
  skippedNoChoice: number;
}

function collect(parts: readonly number[]): Collected {
  const cards = loadCardIndex();
  const simulator = seededSimulator(createBattleSimulator(), SEED);
  console.log(`зерно ${String(SEED)}, партий ${String(parts.length)}`);

  const all: SpendComparison[] = [];
  const decisive: SpendComparison[] = [];
  const sameShape: SpendComparison[] = [];
  const inSample: SpendComparison[] = [];
  const outOfSample: SpendComparison[] = [];
  let skippedNoBattle = 0;
  let skippedNoChoice = 0;

  for (const part of parts) {
    const text = readFixtureGame(part);
    if (text === null) {
      console.log(`part${String(part)}: лога нет, пропущено`);
      continue;
    }
    const report = measureSpendQuality(text, { cards, simulator });
    (part <= IN_SAMPLE_UNTIL ? inSample : outOfSample).push(...report.sameShapeRows);
    all.push(...report.rows);
    decisive.push(...report.decisive);
    sameShape.push(...report.sameShapeRows);
    skippedNoBattle += report.skippedNoBattle;
    skippedNoChoice += report.skippedNoChoice;

    console.log(`\n═══ part${String(part)} ═══`);
    console.log('  ход  наборов  план  лучший  цена  разброс  подъём (план/лучший)  остаток (план/лучший)');
    for (const r of report.rows) {
      const cost = r.bestOutcome - r.planOutcome;
      console.log(
        `  ${String(r.turn).padStart(3)}` +
          `  ${String(r.baskets).padStart(7)}` +
          `  ${r.planOutcome.toFixed(0).padStart(4)}%` +
          `  ${r.bestOutcome.toFixed(0).padStart(6)}%` +
          `  ${(cost < 0.05 ? '—' : cost.toFixed(1)).padStart(4)}` +
          `  ${r.spread.toFixed(1).padStart(7)}` +
          `  ${`${r.planLevelUp ? 'да' : 'нет'}/${r.bestLevelUp ? 'да' : 'нет'}`.padStart(20)}` +
          `  ${`${String(r.planGoldLeft)}/${String(r.bestGoldLeft)}`.padStart(20)}`,
      );
    }
  }

  return { all, decisive, sameShape, inSample, outOfSample, skippedNoBattle, skippedNoChoice };
}

/**
 * Склейка кусков в порядке партий.
 *
 * Порядок здесь — это порядок файлов кусков, а тот задан номером партии,
 * поэтому склеенный массив поэлементно равен собранному прогоном подряд.
 */
function concat(pieces: readonly Collected[]): Collected {
  return {
    all: pieces.flatMap((p) => p.all),
    decisive: pieces.flatMap((p) => p.decisive),
    sameShape: pieces.flatMap((p) => p.sameShape),
    inSample: pieces.flatMap((p) => p.inSample),
    outOfSample: pieces.flatMap((p) => p.outOfSample),
    skippedNoBattle: pieces.reduce((s, p) => s + p.skippedNoBattle, 0),
    skippedNoChoice: pieces.reduce((s, p) => s + p.skippedNoChoice, 0),
  };
}

function summarize(collected: Collected): void {
  const { all, decisive, sameShape, inSample, outOfSample, skippedNoBattle, skippedNoChoice } = collected;

  const percent = (rows: readonly SpendComparison[]): number | null =>
    rows.length === 0 ? null : round(spendAgreement(rows) * 100, 1);
  const cost = (rows: readonly SpendComparison[]): number | null =>
    rows.length === 0 ? null : round(spendCost(rows), 2);
  const shapeDecisiveRows = sameShape.filter((r) => r.spread > 5);
  emitResult({
    seed: SEED,
    parts: FIXTURES,
    metrics: {
      turns: all.length,
      agreementPct: percent(all),
      costPp: cost(all),
      decisiveTurns: decisive.length,
      sameShapeTurns: sameShape.length,
      sameShapeAgreementPct: percent(sameShape),
      sameShapeCostPp: cost(sameShape),
      sameShapeDecisiveTurns: shapeDecisiveRows.length,
      goldLeftPlan: all.length === 0 ? null : round(averageGoldLeft(all, (r) => r.planGoldLeft), 2),
      goldLeftBest: all.length === 0 ? null : round(averageGoldLeft(all, (r) => r.bestGoldLeft), 2),
      inSampleTurns: inSample.length,
      inSampleAgreementPct: percent(inSample),
      outOfSampleTurns: outOfSample.length,
      outOfSampleAgreementPct: percent(outOfSample),
      skippedNoBattle,
      skippedNoChoice,
    },
  });

  console.log('\n═══ итог ═══');
  if (all.length === 0) {
    console.log('  сравнивать было нечего');
    return;
  }
  console.log(`  ходов со сравнением:          ${String(all.length)}`);
  console.log(
    `  план совпал с лучшим набором: ${String(all.filter((r) => r.agreed).length)}` +
      ` (${(spendAgreement(all) * 100).toFixed(0)}%)`,
  );
  console.log(`  средняя цена расхождения:     ${spendCost(all).toFixed(2)} п.п.`);
  console.log(`  выбор что-то решал на:        ${String(decisive.length)} ходах`);
  if (decisive.length > 0) {
    console.log(
      `    там совпал:                 ${String(decisive.filter((r) => r.agreed).length)}` +
        ` (${(spendAgreement(decisive) * 100).toFixed(0)}%)` +
        `, средняя цена ${spendCost(decisive).toFixed(1)} п.п.`,
    );
  }
  console.log(
    `  золота сгорает: у плана ${averageGoldLeft(all, (r) => r.planGoldLeft).toFixed(2)},` +
      ` у лучшего набора ${averageGoldLeft(all, (r) => r.bestGoldLeft).toFixed(2)}`,
  );
  const shapeDecisive = sameShape.filter((r) => r.spread > 5);
  console.log(
    `\n  ВНУТРИ ФОРМЫ (та же длина набора, то же решение о подъёме):` +
      ` ходов ${String(sameShape.length)},` +
      ` совпало ${(spendAgreement(sameShape) * 100).toFixed(0)}%,` +
      ` цена ${spendCost(sameShape).toFixed(2)} п.п.`,
  );
  console.log(
    `    из них решающих ${String(shapeDecisive.length)}:` +
      ` совпало ${(spendAgreement(shapeDecisive) * 100).toFixed(0)}%,` +
      ` цена ${spendCost(shapeDecisive).toFixed(1)} п.п.`,
  );
  console.log(
    `  пропущено: без боя следом ${String(skippedNoBattle)},` +
      ` без выбора или вне перебора ${String(skippedNoChoice)}`,
  );

  // Разводка считается ВНУТРИ ФОРМЫ — по главному итогу этой сверки.
  const line = (label: string, rows: readonly SpendComparison[]): void => {
    if (rows.length === 0) return;
    console.log(
      `  ${label.padEnd(34)} ходов ${String(rows.length).padStart(3)}` +
        `, совпало ${(spendAgreement(rows) * 100).toFixed(0).padStart(2)}%` +
        `, цена ${spendCost(rows).toFixed(2)} п.п.`,
    );
  };
  console.log('\n═══ разводка по загрязнению (внутри формы) ═══');
  line(`part4–part${String(IN_SAMPLE_UNTIL)} (внутри выборки)`, inSample);
  line(`part${String(IN_SAMPLE_UNTIL + 1)}+ (вне выборки)`, outOfSample);
  console.log(
    '\n  Читать с оговоркой: сравнивается только ближайший бой, и купленные\n' +
      '  тела дописываются в хвост борда без поиска расстановки. Поэтому\n' +
      '  главный итог — строка «внутри формы»: там у наборов одна длина\n' +
      '  и одно решение о подъёме, и вопрос сводится к «те ли тела куплены».',
  );
}

function main(): void {
  const shardOut = shardOutArg(process.argv);
  const shardIn = shardInArg(process.argv);
  // Склейка не грузит ни карт, ни симулятора: метрики — числа над числами.
  const collected = shardIn === null ? collect(FIXTURES) : concat(readShards<Collected>(shardIn));
  if (shardOut !== null) {
    writeShard(shardOut, collected);
    return;
  }
  summarize(collected);
}

main();
