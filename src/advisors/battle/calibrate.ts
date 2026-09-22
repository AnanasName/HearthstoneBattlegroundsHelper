/**
 * Калибровка симулятора на боях с известным исходом.
 *
 *   npm run calibrate
 *
 * ТЗ формулирует DoD фазы 2 как «фактический исход не является выбросом».
 * По одному бою это почти нельзя опровергнуть: если симулятор дал поражению
 * 30%, а мы проиграли, это ничего не доказывает. Поэтому здесь считаются
 * агрегатные метрики по всем боям всех фикстур:
 *
 *   - калибровка: средняя предсказанная вероятность победы против фактической
 *     доли побед. У честного предсказателя они близки;
 *   - Brier score: средний квадрат ошибки вероятности, чем меньше тем лучше.
 *     0.25 — уровень «всегда говорить 50%»;
 *   - доля боёв, где фактический исход получил меньше 5% вероятности.
 *     Это и есть «выбросы» из формулировки ТЗ.
 */
import { readFileSync } from 'node:fs';

import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { positionalArgs, seedArg } from '../../measure/args.js';
import { emitResult, round } from '../../measure/result.js';
import { readShards, shardInArg, shardOutArg, writeShard } from '../../measure/shard.js';
import { readBattleEpisodes, type Outcome } from './episodes.js';
import { toBattleInfo } from './mapper.js';
import { seededSimulator } from './seeded.js';
import { createBattleSimulator } from './simulator.js';

/**
 * На чём калибруемся.
 *
 * По умолчанию — партии текущего патча: карты и правила меняются, а записанный
 * исход относится к тому билду, при котором партия сыграна. Проверено 13.08:
 * после обновления карт и симулятора расхождение на партиях билда 246003
 * выросло с 3.9 до 9.0 п.п., хотя ни парсер, ни маппер не менялись.
 * Старые партии остаются годными для проверки разбора лога, но не для
 * калибровки предсказаний.
 *
 * Аргументом можно передать другой лог: `npm run calibrate -- <путь>`.
 */
const FIXTURES = ['data/fixtures/part4/game.log'] as const;

const SIMULATIONS = 3000;
/** Порог, ниже которого исход считаем выбросом. */
const OUTLIER = 0.05;

function predicted(result: SimulationResult, outcome: Outcome): number {
  switch (outcome) {
    case 'won':
      return result.wonPercent / 100;
    case 'lost':
      return result.lostPercent / 100;
    case 'tied':
      return result.tiedPercent / 100;
  }
}

/**
 * Бой в том виде, в каком его читают метрики и список выбросов.
 *
 * Не весь эпизод с бордами, а ровно те поля, что нужны после счёта: строка
 * едет между процессами куском (`--shard-out`), а борды весят на три порядка
 * больше и после симуляции не нужны никому.
 */
interface Row {
  readonly fixture: string;
  readonly turn: number;
  readonly outcome: Outcome;
  /** Предсказанная вероятность ПОБЕДЫ: из неё считаются калибровка и Brier. */
  readonly wonPercent: number;
  /** Вероятность, которую симулятор дал фактическому исходу. */
  readonly p: number;
  readonly playerBoardSize: number;
  readonly opponentBoardSize: number;
}

function collect(fixtures: readonly string[], seed: number): Row[] {
  const simulator = seededSimulator(createBattleSimulator(), seed);
  console.log(`зерно ${String(seed)}`);

  const rows: Row[] = [];

  for (const path of fixtures) {
    const episodes = readBattleEpisodes(readFileSync(path, 'utf8'));
    const short = path.split('/')[2] ?? path;
    console.log(`\n═══ ${short}: боёв ${String(episodes.length)} ═══`);
    console.log('  ход   мой борд  враг   факт        предсказано (побед/ничьих/поражений)');

    for (const episode of episodes) {
      const result = simulator.run(toBattleInfo(episode, SIMULATIONS));
      const p = predicted(result, episode.outcome);
      rows.push({
        fixture: short,
        turn: episode.turn,
        outcome: episode.outcome,
        wonPercent: result.wonPercent,
        p,
        playerBoardSize: episode.playerBoard.length,
        opponentBoardSize: episode.opponentBoard.length,
      });

      console.log(
        `  ${String(episode.turn).padStart(3)}` +
          `  ${String(episode.playerBoard.length).padStart(8)}` +
          `  ${String(episode.opponentBoard.length).padStart(4)}` +
          `  ${episode.outcome.padEnd(10)}` +
          `  ${result.wonPercent.toFixed(0).padStart(3)}% / ` +
          `${result.tiedPercent.toFixed(0).padStart(3)}% / ` +
          `${result.lostPercent.toFixed(0).padStart(3)}%` +
          `   вероятность факта ${(p * 100).toFixed(0).padStart(3)}%`,
      );
    }
  }

  return rows;
}

function summarize(rows: readonly Row[], seed: number): void {
  if (rows.length === 0) {
    console.log('\nбоёв не найдено');
    return;
  }

  // ─── агрегаты ──────────────────────────────────────────────────────────────
  const wins = rows.filter((r) => r.outcome === 'won').length;
  const meanPredictedWin =
    rows.reduce((sum, r) => sum + r.wonPercent / 100, 0) / rows.length;
  const actualWinRate = wins / rows.length;

  const brier =
    rows.reduce((sum, r) => {
      const actual = r.outcome === 'won' ? 1 : 0;
      const diff = r.wonPercent / 100 - actual;
      return sum + diff * diff;
    }, 0) / rows.length;

  const outliers = rows.filter((r) => r.p < OUTLIER);

  emitResult({
    seed,
    parts: null,
    metrics: {
      battles: rows.length,
      actualWinPct: round(actualWinRate * 100, 1),
      meanPredictedWinPct: round(meanPredictedWin * 100, 1),
      calibrationGapPp: round(Math.abs(meanPredictedWin - actualWinRate) * 100, 1),
      brier: round(brier, 3),
      outliers: outliers.length,
    },
  });

  console.log(`\n═══ итог по ${String(rows.length)} боям ═══`);
  console.log(`  фактическая доля побед:      ${(actualWinRate * 100).toFixed(1)}%`);
  console.log(`  средняя предсказанная:       ${(meanPredictedWin * 100).toFixed(1)}%`);
  console.log(
    `  расхождение калибровки:      ${(Math.abs(meanPredictedWin - actualWinRate) * 100).toFixed(1)} п.п.`,
  );
  console.log(`  Brier score:                 ${brier.toFixed(3)}  (0.25 = «всегда 50%»)`);
  console.log(
    `  исходов с вероятностью <${String(OUTLIER * 100)}%: ${String(outliers.length)} из ${String(rows.length)}`,
  );

  if (outliers.length > 0) {
    console.log('\n  выбросы — там симулятор ошибся сильнее всего:');
    for (const r of outliers) {
      console.log(
        `    ${r.fixture} ход ${String(r.turn).padStart(2)}: факт ${r.outcome}` +
          `, дано ${(r.p * 100).toFixed(1)}%` +
          `  (борды ${String(r.playerBoardSize)} на ${String(r.opponentBoardSize)})`,
      );
    }
  }
}

function main(): void {
  const seed = seedArg(process.argv);
  const shardOut = shardOutArg(process.argv);
  const shardIn = shardInArg(process.argv);
  // Склейка не грузит ни карт, ни симулятора: метрики — числа над числами.
  if (shardIn !== null) {
    summarize(readShards<Row[]>(shardIn).flat(), seed);
    return;
  }
  const paths = positionalArgs(process.argv.slice(2));
  const rows = collect(paths.length > 0 ? paths : FIXTURES, seed);
  if (shardOut !== null) {
    writeShard(shardOut, rows);
    return;
  }
  summarize(rows, seed);
}

main();
